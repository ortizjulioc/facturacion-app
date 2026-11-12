import { tenantTransaction, type Prisma } from "@facturacion/db";
import { FiscalError, PeerClient } from "@facturacion/ecf";
import { clientFor, type FiscalDeps } from "./fiscal";
import { loadSigner } from "./signing";
import type { TenantTx } from "../types";

/**
 * Entrega del e-CF al comprador que también es contribuyente electrónico (Informe Técnico e-CF, pág. 12, pasos 1–4):
 * cuando la DGII acepta el comprobante, el emisor lo envía al servicio de recepción del comprador (según el directorio
 * de la DGII) y guarda el acuse de recibo (ARECF) que este devuelve.
 */

/** Esperas (segundos) entre reintentos de una entrega; la última se repite. */
export const DELIVERY_BACKOFF_SECONDS = [60, 300, 1_800, 3_600];
/** Intentos antes de dejar la entrega para revisión. */
export const MAX_DELIVERY_ATTEMPTS = 20;
const LOCK_SECONDS = 120;

const later = (now: Date, seconds: number) => new Date(now.getTime() + seconds * 1000);
const iso = (d: Date) => d.toISOString();

/** Tipos que se entregan a un comprador contribuyente (la factura de consumo no tiene receptor electrónico). */
const DELIVERED_TYPES = new Set(["E31", "E33", "E34"]);

/** Encola la entrega si el comprobante va a un contribuyente identificado con RNC o cédula. No hace nada si ya existe. */
export async function enqueueDelivery(
  tx: TenantTx,
  organizationId: string,
  doc: { id: string; type: string; buyerDocType: string | null; buyerDocNumber: string | null },
): Promise<boolean> {
  if (!DELIVERED_TYPES.has(doc.type) || !doc.buyerDocNumber || (doc.buyerDocType !== "RNC" && doc.buyerDocType !== "CEDULA")) return false;
  if (await tx.ecfDelivery.findFirst({ where: { documentId: doc.id }, select: { id: true } })) return false;
  await tx.ecfDelivery.create({ data: { organizationId, documentId: doc.id, buyerRnc: doc.buyerDocNumber } });
  return true;
}

/** Vuelve a poner en la cola una entrega fallida o no recibida (p. ej. después de que el comprador corrigió su servicio). */
export async function retryDelivery(tx: TenantTx, documentId: string): Promise<boolean> {
  const { count } = await tx.ecfDelivery.updateMany({
    where: { documentId, state: { in: ["FAILED", "NOT_RECEIVED", "NOT_ELECTRONIC"] } },
    data: { state: "PENDING", attempts: 0, lastError: null, nextAttemptAt: new Date(), lockedUntil: null },
  });
  return count > 0;
}

/** Intenta una entrega. Nunca lanza por errores de la red o del comprador: los anota en la fila. */
export async function deliverOne(deps: FiscalDeps, organizationId: string, id: string, now: Date = new Date()) {
  const loaded = await tenantTransaction(deps.prisma, organizationId, async (tx) => ({
    row: await tx.ecfDelivery.findFirst({ where: { id }, include: { document: { select: { encf: true, ecfXml: true } } } }),
    profile: await tx.companyProfile.findFirst({ select: { rnc: true, environment: true } }),
    cert: await loadSigner(tx, deps.env, organizationId),
  }));
  const { row, profile, cert } = loaded;
  if (!row || row.state !== "PENDING") return row;

  const save = (data: Prisma.EcfDeliveryUncheckedUpdateInput) =>
    tenantTransaction(deps.prisma, organizationId, (tx) => tx.ecfDelivery.update({ where: { id }, data: { ...data, lockedUntil: null } }));
  const attempts = row.attempts + 1;

  if (!profile || !cert) return save({ state: "FAILED", attempts, lastError: "Falta el certificado digital de la empresa" });
  if (!row.document.ecfXml || !row.document.encf) return save({ state: "FAILED", attempts, lastError: "El comprobante no está firmado" });

  try {
    const entry = await clientFor(cert, profile.environment, deps.fetch).directoryOf(row.buyerRnc);
    if (!entry?.receptionUrl) {
      return save({ state: "NOT_ELECTRONIC", attempts, lastError: "El comprador no está en el directorio de contribuyentes electrónicos de la DGII" });
    }
    const ack = await new PeerClient({ certificate: cert, ...(deps.fetch ? { fetch: deps.fetch } : {}) }).sendEcf(entry, row.document.ecfXml, profile.rnc, row.document.encf);
    return save({
      state: ack.received ? "DELIVERED" : "NOT_RECEIVED",
      attempts,
      lastError: null,
      ackXml: ack.xml,
      ackStatus: ack.received ? 0 : 1,
      ackReason: ack.reason,
      deliveredAt: now,
    });
  } catch (e) {
    if (!(e instanceof FiscalError)) throw e;
    // En certificación no hay directorio: no hay a quién entregar desde aquí (esa prueba la conduce la DGII).
    if (e.kind === "config") return save({ state: "NOT_ELECTRONIC", attempts, lastError: e.message });
    if (e.retryable && attempts < MAX_DELIVERY_ATTEMPTS) {
      return save({ attempts, lastError: e.message, nextAttemptAt: later(now, DELIVERY_BACKOFF_SECONDS[Math.min(attempts - 1, DELIVERY_BACKOFF_SECONDS.length - 1)]!) });
    }
    return save({ state: "FAILED", attempts, lastError: e.message });
  }
}

/** Entrega lo que ya toca (todas las empresas): lo llama el trabajador del servidor. Nunca lanza. */
export async function processDeliveries(deps: FiscalDeps, now: Date = new Date(), limit = 20, organizationId?: string): Promise<number> {
  const until = later(now, LOCK_SECONDS);
  const rows = await deps.prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.system', 'fiscal-worker', TRUE)`;
    return tx.$queryRaw<{ id: string; organizationId: string }[]>`
      UPDATE "ecf_delivery" SET "lockedUntil" = ${iso(until)}::timestamp, "updatedAt" = now()
      WHERE "id" IN (
        SELECT "id" FROM "ecf_delivery"
        WHERE "state" = 'PENDING'::"DeliveryState"
          AND "nextAttemptAt" <= ${iso(now)}::timestamp
          AND ("lockedUntil" IS NULL OR "lockedUntil" < ${iso(now)}::timestamp)
          AND (${organizationId ?? null}::text IS NULL OR "organizationId" = ${organizationId ?? null}::text)
        ORDER BY "nextAttemptAt"
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING "id", "organizationId"`;
  });
  for (const r of rows) {
    await deliverOne(deps, r.organizationId, r.id, now).catch((err) => {
      deps.logger.error({ err, deliveryId: r.id }, "fallo entregando un e-CF al comprador");
    });
  }
  return rows.length;
}
