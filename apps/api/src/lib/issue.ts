import { HTTPException } from "hono/http-exception";
import { buyerErrors, formatDop, isModifier, remainingCredit } from "@facturacion/core";
import { auditRow } from "./audit";
import { asSalesType, FULL, type DocumentFull } from "./documents";
import { allocateEncf } from "./encf";
import { enqueueIfAuto } from "./fiscal-queue";
import { signDocumentData, type Signature } from "./signing";
import { applyDocumentStock } from "./stock";
import type { Env } from "../env";
import type { TenantTx } from "../types";

const unprocessable = (message: string) => new HTTPException(422, { message });

/**
 * Emite un borrador: valida las reglas fiscales, asigna el e-NCF, descuenta el inventario y lo congela.
 *
 * Todo ocurre dentro de la transacción de quien llama: si algo falla (sin secuencia, sin existencia,
 * pagos que no suman…), no se asigna número ni se mueve inventario. La usan la facturación normal
 * (`POST /v1/documents/:id/issue`) y el cobro de mesas del restaurante.
 */
export async function issueDocument(
  tx: TenantTx,
  params: {
    id: string;
    organizationId: string;
    userId: string;
    env: Env;
    /**
     * Venta hecha SIN conexión en una caja: el e-NCF y la fecha ya existen (salieron del bloque de la caja y
     * están impresos en el ticket), así que no se asigna número ni se rechaza por existencia: la venta ya ocurrió.
     */
    preset?: { encf: string; issuedAt: Date; shiftId?: string | null };
  },
): Promise<DocumentFull> {
  const { id, organizationId, userId, env, preset } = params;

  const draft = await tx.document.findFirst({ where: { id }, include: FULL });
  if (!draft) throw new HTTPException(404, { message: "Comprobante no encontrado" });
  if (draft.status !== "DRAFT") {
    throw new HTTPException(409, { message: "Este comprobante ya fue emitido" });
  }

  const profile = await tx.companyProfile.findFirst();
  if (!profile) {
    throw unprocessable("Registra los datos fiscales de la empresa antes de emitir comprobantes");
  }
  if (draft.total <= 0n) throw unprocessable("El total del comprobante debe ser mayor que cero");

  // El comprador se refresca desde la ficha del cliente: pudo cambiar desde que se creó el borrador.
  let buyer = {
    buyerName: draft.buyerName,
    buyerDocType: draft.buyerDocType,
    buyerDocNumber: draft.buyerDocNumber,
  };
  const type = asSalesType(draft.type);
  if (draft.customerId && !isModifier(type)) {
    const customer = await tx.customer.findFirst({ where: { id: draft.customerId } });
    if (customer) {
      buyer = {
        buyerName: customer.name,
        buyerDocType: customer.documentType,
        buyerDocNumber: customer.documentNumber,
      };
    }
  }

  if (!isModifier(type)) {
    const [problem] = buyerErrors(type, draft.total, {
      docType: buyer.buyerDocType,
      docNumber: buyer.buyerDocNumber,
    });
    if (problem) throw unprocessable(problem);

    const paid = draft.payments.reduce((sum, p) => sum + p.amount, 0n);
    if (paid !== draft.total) {
      throw unprocessable(
        `Los pagos (${formatDop(paid)}) deben sumar el total del comprobante (${formatDop(draft.total)})`,
      );
    }
  }

  if (draft.type === "E34" && draft.referencedDocumentId) {
    // Se bloquea el comprobante original para que dos notas simultáneas no excedan su monto.
    await tx.$queryRaw`SELECT 1 FROM "document" WHERE "id" = ${draft.referencedDocumentId}::uuid FOR UPDATE`;
    const original = await tx.document.findFirstOrThrow({
      where: { id: draft.referencedDocumentId },
    });
    const credited = await tx.document.aggregate({
      _sum: { total: true },
      where: { referencedDocumentId: original.id, type: "E34", status: { not: "DRAFT" } },
    });
    const already = credited._sum.total ?? 0n;
    const left = remainingCredit(original.total, already);
    if (draft.total > left) {
      throw unprocessable(
        `La nota de crédito (${formatDop(draft.total)}) excede lo que queda por acreditar (${formatDop(left)})`,
      );
    }
    if (draft.modificationCode === 1 && (already > 0n || draft.total !== original.total)) {
      throw unprocessable(
        "Para anular el comprobante la nota debe ser por el total y no puede haber otras notas de crédito",
      );
    }
  }

  // Si la caja tiene un turno abierto, el comprobante queda en ese turno. FOR SHARE: el cierre del turno
  // (FOR UPDATE) espera a las emisiones en curso, así que ningún comprobante se escapa del informe Z.
  // Las ventas subidas desde una caja sin conexión traen su turno (ya cerrado o no) y no usan el de hoy.
  let shiftId: string | null = preset?.shiftId ?? null;
  if (draft.terminalId && !preset) {
    const open = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "cash_shift"
      WHERE "terminalId" = ${draft.terminalId}::uuid AND "status" = 'OPEN' FOR SHARE`;
    shiftId = open[0]?.id ?? null;
    if (!shiftId && profile.requireShift) {
      throw unprocessable("Abre un turno en esta caja antes de emitir comprobantes");
    }
  }
  const encf = preset?.encf ?? (await allocateEncf(tx, draft.type, draft.terminalId));
  const issuedAt = preset?.issuedAt ?? new Date();

  // Si la empresa tiene certificado digital, el e-CF se firma en el mismo instante en que se emite. Una venta
  // de caja sin conexión ya ocurrió (y está impresa): si no se puede firmar, queda emitida sin firma y se firma después.
  let signature: Signature | null = null;
  try {
    signature = await signDocumentData(tx, env, organizationId, { ...draft, encf, issuedAt, ...buyer }, profile);
  } catch (e) {
    if (!preset) throw e;
    await tx.auditLog.create({
      data: auditRow({ organizationId, userId }, "document.sign_failed", "document", id, {
        encf,
        reason: e instanceof Error ? e.message : String(e),
      }),
    });
  }

  let issued = await tx.document.update({
    where: { id },
    data: { status: "ISSUED", encf, issuedAt, shiftId, ...buyer, ...signature },
    include: FULL,
  });
  // Con envío automático, el comprobante firmado entra a la cola de la DGII en la misma transacción.
  if (await enqueueIfAuto(tx, organizationId, issued, profile)) {
    issued = await tx.document.findFirstOrThrow({ where: { id }, include: FULL });
  }
  // Descuenta (o reingresa) las existencias en la misma transacción: si no hay stock, no se emite.
  await applyDocumentStock(tx, issued, userId, preset ? true : profile.allowNegativeStock);
  await tx.auditLog.create({
    data: auditRow({ organizationId, userId }, "document.issue", "document", id, {
      encf,
      type: issued.type,
      total: formatDop(issued.total),
    }),
  });
  return issued;
}
