import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
  calculateDocument,
  DOCUMENT_TYPES,
  ECF_TYPES,
  fromCents,
  fromMilli,
  isModifier,
  normalizeDocument,
  TAX_CODES,
  toCents,
  toMilli,
  type DocumentTotals,
  type EcfType,
  type LineInput,
} from "@facturacion/core";
import { Prisma } from "@facturacion/db";
import { money, optionalText, quantity } from "./schemas";
import { fiscalBlock } from "./fiscal-queue";
import { stampOf, type StampProfile } from "./stamp";
import type { TenantTx } from "../types";

// ───────────── Entrada ─────────────

export const lineInput = z.object({
  productId: z.uuid().nullish(),
  // Obligatorios solo cuando la línea no viene de un producto.
  name: z.string().trim().min(1).max(200).optional(),
  description: optionalText(1000),
  unitPrice: money.optional(),
  tax: z.enum(TAX_CODES).optional(),
  priceIncludesTax: z.boolean().optional(),
  quantity,
  discount: z
    .discriminatedUnion("type", [
      z.object({ type: z.literal("percent"), bps: z.number().int().min(0).max(10_000) }),
      z.object({ type: z.literal("amount"), amount: money }),
    ])
    .optional(),
});

export const paymentInput = z.object({
  method: z.enum(["CASH", "TRANSFER", "CHECK", "CARD", "CREDIT", "OTHER"]),
  amount: money,
  reference: optionalText(100),
});

export const documentInput = z
  .object({
    type: z.enum(ECF_TYPES),
    branchId: z.uuid(),
    terminalId: z.uuid().nullish(),
    customerId: z.uuid().nullish(),
    /** Comprador sin ficha de cliente (p. ej. consumidor identificado por cédula). */
    buyer: z
      .object({
        name: z.string().trim().max(200).nullish(),
        docType: z.enum(DOCUMENT_TYPES).nullish(),
        docNumber: z.string().trim().max(30).nullish(),
      })
      .nullish(),
    currency: z.enum(["DOP", "USD"]).default("DOP"),
    exchangeRate: z
      .string()
      .regex(/^\d{1,6}(\.\d{1,4})?$/, "Tasa de cambio inválida")
      .default("1"),
    propinaLegal: z.boolean().default(false),
    notes: optionalText(1000),
    referencedDocumentId: z.uuid().nullish(),
    modificationCode: z.number().int().min(1).max(5).nullish(),
    lines: z.array(lineInput).min(1, "Agrega al menos una línea").max(500),
    payments: z.array(paymentInput).max(20).default([]),
  })
  .superRefine((v, ctx) => {
    if (v.currency === "DOP" && Number(v.exchangeRate) !== 1) {
      ctx.addIssue({
        code: "custom",
        path: ["exchangeRate"],
        message: "En pesos la tasa de cambio es 1",
      });
    }
    if (v.currency === "USD" && Number(v.exchangeRate) <= 1) {
      ctx.addIssue({
        code: "custom",
        path: ["exchangeRate"],
        message: "Indica la tasa de cambio del dólar",
      });
    }
    if (isModifier(v.type)) {
      if (!v.referencedDocumentId) {
        ctx.addIssue({
          code: "custom",
          path: ["referencedDocumentId"],
          message: "Indica el comprobante que modifica",
        });
      }
      if (!v.modificationCode) {
        ctx.addIssue({
          code: "custom",
          path: ["modificationCode"],
          message: "Indica el código de modificación",
        });
      }
    } else if (v.referencedDocumentId || v.modificationCode) {
      ctx.addIssue({
        code: "custom",
        path: ["referencedDocumentId"],
        message: "Solo las notas de crédito o débito referencian otro comprobante",
      });
    }
  });

export type DocumentInput = z.infer<typeof documentInput>;

// ───────────── Construcción del borrador ─────────────

const unprocessable = (message: string) => new HTTPException(422, { message });

/**
 * Un `Document` es siempre de VENTA (E31–E34; lo garantiza una restricción en la base de datos).
 * El enum de Prisma incluye también E41/E43 porque comparte la numeración con las compras,
 * así que aquí se acota el tipo y, por seguridad, se verifica en ejecución.
 */
export function asSalesType(type: string): EcfType {
  if (!(ECF_TYPES as readonly string[]).includes(type)) {
    throw new HTTPException(500, {
      message: `Tipo de comprobante de venta inválido: ${type}`,
    });
  }
  return type as EcfType;
}

/** Todo lo necesario para insertar un documento; los totales salen siempre de `core`. */
export async function buildDraft(
  tx: TenantTx,
  input: DocumentInput,
  opts: { allowInactiveProducts?: boolean } = {},
) {
  // Sucursal y caja deben existir (RLS oculta las de otras empresas) y estar activas.
  const branch = await tx.branch.findFirst({
    where: { id: input.branchId, active: true },
  });
  if (!branch) throw unprocessable("La sucursal no existe o está inactiva");
  if (input.terminalId) {
    const terminal = await tx.terminal.findFirst({
      where: { id: input.terminalId, branchId: input.branchId, active: true },
    });
    if (!terminal)
      throw unprocessable(
        "La caja no existe, está inactiva o no pertenece a la sucursal",
      );
  }

  const referenced = input.referencedDocumentId
    ? await tx.document.findFirst({ where: { id: input.referencedDocumentId } })
    : null;
  if (input.referencedDocumentId) {
    if (!referenced) throw unprocessable("El comprobante a modificar no existe");
    if (referenced.status === "DRAFT")
      throw unprocessable("El comprobante a modificar aún no está emitido");
    if (referenced.type !== "E31" && referenced.type !== "E32") {
      throw unprocessable(
        "Solo se pueden modificar facturas de crédito fiscal o de consumo",
      );
    }
  }

  const buyer = await resolveBuyer(tx, input, referenced);

  // Líneas: se copian los datos del producto al momento de la venta.
  const productIds = [
    ...new Set(input.lines.flatMap((l) => (l.productId ? [l.productId] : []))),
  ];
  const products = productIds.length
    ? await tx.product.findMany({ where: { id: { in: productIds } } })
    : [];
  const byId = new Map(products.map((p) => [p.id, p]));

  const resolved = input.lines.map((l, i) => {
    const where = `Línea ${i + 1}`;
    const product = l.productId ? byId.get(l.productId) : undefined;
    if (l.productId && !product) throw unprocessable(`${where}: el producto no existe`);
    // Cobrar una comanda ya servida debe poder hacerse aunque el producto se desactive después.
    if (product && !product.active && !opts.allowInactiveProducts)
      throw unprocessable(`${where}: "${product.name}" está inactivo`);

    const name = l.name ?? product?.name;
    const tax = l.tax ?? product?.tax;
    const unitPrice = l.unitPrice !== undefined ? toCents(l.unitPrice) : product?.price;
    if (!name || !tax || unitPrice === undefined) {
      throw unprocessable(
        `${where}: indica nombre, precio e impuesto, o elige un producto`,
      );
    }
    const qty = toMilli(l.quantity);
    if (qty <= 0n) throw unprocessable(`${where}: la cantidad debe ser mayor que cero`);
    if (product && !product.allowsDecimals && qty % 1000n !== 0n) {
      throw unprocessable(`${where}: "${product.name}" no se vende en fracciones`);
    }

    const discount: LineInput["discount"] = !l.discount
      ? undefined
      : l.discount.type === "percent"
        ? { type: "percent", bps: l.discount.bps }
        : { type: "amount", cents: toCents(l.discount.amount) };

    return {
      core: {
        unitPrice,
        quantity: qty,
        tax,
        priceIncludesTax: l.priceIncludesTax ?? product?.priceIncludesTax ?? false,
        ...(discount ? { discount } : {}),
      } satisfies LineInput,
      productId: product?.id ?? null,
      name,
      description: l.description ?? product?.description ?? null,
      unit: product?.unit ?? "UND",
    };
  });

  let totals: DocumentTotals;
  try {
    totals = calculateDocument({
      lines: resolved.map((r) => r.core),
      propinaLegal: input.propinaLegal,
    });
  } catch (e) {
    throw unprocessable(
      e instanceof Error ? e.message : "No se pudieron calcular los totales",
    );
  }

  const lines = resolved.map((r, i) => {
    const t = totals.lines[i]!;
    return {
      lineNumber: i + 1,
      productId: r.productId,
      name: r.name,
      description: r.description,
      unit: r.unit,
      quantity: r.core.quantity,
      unitPrice: r.core.unitPrice,
      priceIncludesTax: r.core.priceIncludesTax,
      tax: r.core.tax,
      discountType: r.core.discount
        ? r.core.discount.type === "percent"
          ? "PERCENT"
          : "AMOUNT"
        : null,
      discountValue: r.core.discount
        ? r.core.discount.type === "percent"
          ? BigInt(r.core.discount.bps)
          : r.core.discount.cents
        : null,
      gross: t.gross,
      discount: t.discount,
      base: t.base,
      taxAmount: t.taxAmount,
      total: t.total,
    };
  });

  const payments = input.payments.map((p) => ({
    method: p.method,
    amount: toCents(p.amount),
    reference: p.reference ?? null,
  }));
  if (payments.some((p) => p.amount <= 0n))
    throw unprocessable("Los pagos deben ser mayores que cero");

  const document = {
    type: input.type,
    branchId: input.branchId,
    terminalId: input.terminalId ?? null,
    ...buyer,
    // Una nota hereda la moneda del comprobante que modifica.
    currency: referenced?.currency ?? input.currency,
    exchangeRate: referenced ? referenced.exchangeRate : input.exchangeRate,
    propinaLegal: input.propinaLegal,
    notes: input.notes ?? null,
    referencedDocumentId: referenced?.id ?? null,
    referencedEncf: referenced?.encf ?? null,
    modificationCode: input.modificationCode ?? null,
    totalDiscount: totals.totalDiscount,
    subtotal: totals.subtotal,
    base18: totals.byTax.ITBIS18.base,
    tax18: totals.byTax.ITBIS18.taxAmount,
    base16: totals.byTax.ITBIS16.base,
    tax16: totals.byTax.ITBIS16.taxAmount,
    base0: totals.byTax.ITBIS0.base,
    baseExempt: totals.byTax.EXENTO.base,
    totalTax: totals.totalTax,
    propinaAmount: totals.propinaLegal,
    total: totals.total,
  };

  return { document, lines, payments };
}

async function resolveBuyer(
  tx: TenantTx,
  input: DocumentInput,
  referenced: Prisma.DocumentGetPayload<object> | null,
) {
  const none = {
    customerId: null,
    buyerName: null,
    buyerDocType: null,
    buyerDocNumber: null,
  };

  // Las notas heredan el comprador del comprobante que modifican.
  if (referenced) {
    return {
      customerId: referenced.customerId,
      buyerName: referenced.buyerName,
      buyerDocType: referenced.buyerDocType,
      buyerDocNumber: referenced.buyerDocNumber,
    };
  }

  if (input.customerId) {
    const customer = await tx.customer.findFirst({
      where: { id: input.customerId, active: true },
    });
    if (!customer) throw unprocessable("El cliente no existe o está inactivo");
    return {
      customerId: customer.id,
      buyerName: customer.name,
      buyerDocType: customer.documentType,
      buyerDocNumber: customer.documentNumber,
    };
  }

  const b = input.buyer;
  if (!b) return none;
  if (Boolean(b.docType) !== Boolean(b.docNumber)) {
    throw unprocessable("Indica el tipo y el número de documento del comprador");
  }
  let docNumber: string | null = null;
  if (b.docType && b.docNumber) {
    const normalized = normalizeDocument(b.docType, b.docNumber);
    if (!normalized.ok) throw unprocessable(normalized.error);
    docNumber = normalized.value;
  }
  return {
    customerId: null,
    buyerName: b.name || null,
    buyerDocType: b.docType ?? null,
    buyerDocNumber: docNumber,
  };
}

// ───────────── Salida ─────────────

export type DocumentFull = Prisma.DocumentGetPayload<{
  include: { lines: true; payments: true; fiscalSubmission: true; issuedApproval: true };
}>;

export const FULL = {
  lines: { orderBy: { lineNumber: "asc" } },
  payments: { orderBy: { createdAt: "asc" } },
  fiscalSubmission: true,
  issuedApproval: true,
} satisfies Prisma.DocumentInclude;

const m = (v: bigint) => fromCents(v);

export const documentSummaryDto = (d: Prisma.DocumentGetPayload<object>) => ({
  id: d.id,
  type: d.type as EcfType,
  status: d.status,
  encf: d.encf,
  buyerName: d.buyerName,
  buyerDocType: d.buyerDocType,
  buyerDocNumber: d.buyerDocNumber,
  currency: d.currency,
  total: m(d.total),
  referencedEncf: d.referencedEncf,
  issuedAt: d.issuedAt,
  createdAt: d.createdAt,
});

/** `profile` (RNC y ambiente de la empresa) solo hace falta para armar la dirección del QR de un comprobante firmado. */
export const documentDto = (d: DocumentFull, profile: StampProfile | null = null) => ({
  ...documentSummaryDto(d),
  /** Firma del e-CF y datos del timbre (QR) de la representación impresa; null si aún no está firmado. */
  /** Envío a la DGII: estado de la cola y respuesta de la DGII. */
  fiscal: d.fiscalSubmission
    ? {
        kind: d.fiscalSubmission.kind,
        state: d.fiscalSubmission.state,
        trackId: d.fiscalSubmission.trackId,
        attempts: d.fiscalSubmission.attempts,
        nextAttemptAt: d.fiscalSubmission.nextAttemptAt,
        lastError: d.fiscalSubmission.lastError,
        dgiiStatus: d.fiscalSubmission.dgiiStatus,
        dgiiCode: d.fiscalSubmission.dgiiCode,
        messages: (d.fiscalSubmission.messages ?? []) as { code: string; text: string }[],
        sequenceUsed: d.fiscalSubmission.sequenceUsed,
        sentAt: d.fiscalSubmission.sentAt,
        finishedAt: d.fiscalSubmission.finishedAt,
      }
    : null,
  /** Respuesta comercial del cliente (aprobó o rechazó este comprobante), si la mandó. */
  approval: d.issuedApproval
    ? { approved: d.issuedApproval.approved, reason: d.issuedApproval.reason, at: d.issuedApproval.approvedAtText, receivedAt: d.issuedApproval.receivedAt }
    : null,
  /** Por qué no se puede enviar a la DGII (null = se puede, o ya se envió). */
  fiscalBlock: d.fiscalSubmission ? null : fiscalBlock(d),
  ecf: (() => {
    const stamp = profile ? stampOf(d, profile) : null;
    return d.securityCode && d.signedAt
      ? { securityCode: d.securityCode, signedAt: d.signedAt, qrUrl: stamp?.qrUrl ?? null }
      : null;
  })(),
  branchId: d.branchId,
  terminalId: d.terminalId,
  shiftId: d.shiftId,
  returnsStock: d.returnsStock,
  customerId: d.customerId,
  exchangeRate: d.exchangeRate.toString(),
  propinaLegal: d.propinaLegal,
  notes: d.notes,
  referencedDocumentId: d.referencedDocumentId,
  modificationCode: d.modificationCode,
  totals: {
    discount: m(d.totalDiscount),
    subtotal: m(d.subtotal),
    base18: m(d.base18),
    tax18: m(d.tax18),
    base16: m(d.base16),
    tax16: m(d.tax16),
    base0: m(d.base0),
    baseExempt: m(d.baseExempt),
    tax: m(d.totalTax),
    propina: m(d.propinaAmount),
    total: m(d.total),
  },
  lines: d.lines.map((l) => ({
    lineNumber: l.lineNumber,
    productId: l.productId,
    name: l.name,
    description: l.description,
    unit: l.unit,
    quantity: fromMilli(l.quantity),
    unitPrice: m(l.unitPrice),
    priceIncludesTax: l.priceIncludesTax,
    tax: l.tax,
    discount: m(l.discount),
    /** Descuento tal como se ingresó, para poder reabrir y editar un borrador. */
    discountInput:
      l.discountType === "PERCENT" && l.discountValue !== null
        ? ({ type: "percent", bps: Number(l.discountValue) } as const)
        : l.discountType === "AMOUNT" && l.discountValue !== null
          ? ({ type: "amount", amount: m(l.discountValue) } as const)
          : null,
    gross: m(l.gross),
    base: m(l.base),
    taxAmount: m(l.taxAmount),
    total: m(l.total),
  })),
  payments: d.payments.map((p) => ({
    id: p.id,
    method: p.method,
    amount: m(p.amount),
    reference: p.reference,
  })),
});
