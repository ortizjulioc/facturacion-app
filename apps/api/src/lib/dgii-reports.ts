import {
  build606,
  build607,
  build608,
  CONSUMER_INVOICE_LISTING_THRESHOLD,
  convertCents,
  formatEncf,
  fromCents,
  periodBounds,
  type AnyEcfType,
  type Cents,
  type FormatCode,
  type FormatFile,
  type IdType,
  type Row606,
  type Row607,
  type Row608,
} from "@facturacion/core";
import type { Prisma } from "@facturacion/db";

/**
 * Armado de los formatos 606, 607 y 608 de la DGII a partir de lo que hay en la base de datos. Las reglas del archivo
 * (campos, validaciones) viven en `@facturacion/core`; aquí se decide de dónde sale cada dato:
 *  - 606: compras REGISTRADAS por fecha del comprobante.
 *  - 607: comprobantes emitidos (ni borradores ni rechazados por la DGII) por fecha de emisión en hora de Santo Domingo.
 *  - 608: anulaciones de rangos de e-NCF ya confirmadas por la DGII, por fecha de confirmación.
 * Todo en pesos: lo que está en dólares se convierte con la tasa de cambio del comprobante.
 */

const TZ_OFFSET = "-04:00"; // Santo Domingo: UTC-4 todo el año.
const DAY_MS = 86_400_000;

/** Fecha local (AAAA-MM-DD) de un instante, en hora de Santo Domingo. */
export const localDate = (d: Date) => new Date(d.getTime() - 4 * 3_600_000).toISOString().slice(0, 10);

/** [inicio, fin) del período en hora local. */
export function periodRange(period: string) {
  const b = periodBounds(period);
  if (!b) return null;
  return {
    ...b,
    start: new Date(`${b.from}T00:00:00${TZ_OFFSET}`),
    end: new Date(Date.parse(`${b.to}T00:00:00${TZ_OFFSET}`) + DAY_MS),
  };
}

const toDop = (v: bigint, rate: Prisma.Decimal | string) => convertCents(v, rate.toString());

// ───────────── 606 ─────────────

type PurchaseData = Prisma.PurchaseGetPayload<object>;

/** Tipos de bienes y servicios que son bienes (los demás se informan como servicios). */
const GOODS_EXPENSE_TYPES = new Set([4, 9, 10]);
const PAYMENT_FORM_606: Record<string, number> = { CASH: 1, TRANSFER: 2, CHECK: 2, CARD: 3, CREDIT: 4, OTHER: 7 };

export function row606(p: PurchaseData): Row606 {
  const date = p.invoiceDate.toISOString().slice(0, 10);
  const net = toDop(p.subtotal, p.exchangeRate);
  const goods = GOODS_EXPENSE_TYPES.has(p.expenseType);
  return {
    ref: `${p.ncf ?? "Sin NCF"} · ${p.supplierName ?? "Gasto menor"}`,
    supplierId: p.supplierDocNumber ?? "",
    idType: p.supplierDocType === "RNC" ? 1 : p.supplierDocType === "CEDULA" ? 2 : null,
    expenseType: p.expenseType,
    ncf: p.ncf ?? "",
    modifiedNcf: null,
    date,
    // Al contado se pagó el día del comprobante; a crédito, hasta que se indique la fecha.
    paymentDate: p.paymentDate ? p.paymentDate.toISOString().slice(0, 10) : p.paymentMethod === "CREDIT" ? null : date,
    services: goods ? 0n : net,
    goods: goods ? net : 0n,
    itbis: toDop(p.totalTax, p.exchangeRate),
    itbisWithheld: toDop(p.itbisWithheld, p.exchangeRate),
    itbisProportional: 0n,
    itbisToCost: 0n,
    isrType: p.isrWithholdingType,
    isrWithheld: toDop(p.isrWithheld, p.exchangeRate),
    selective: 0n,
    otherTaxes: 0n,
    tip: 0n,
    paymentForm: PAYMENT_FORM_606[p.paymentMethod] ?? 7,
  };
}

// ───────────── 607 ─────────────

type DocumentData = Prisma.DocumentGetPayload<{ include: { payments: true } }>;

/** Tipos de comprobante que se informan como ventas (los E41/E43 son compras y van en el 606). */
export const SALE_TYPES = ["E31", "E32", "E33", "E34"] as const;

const ID_TYPE_607: Record<string, IdType> = { RNC: 1, CEDULA: 2, PASAPORTE: 3 };

export function row607(d: DocumentData): Row607 {
  const rate = d.exchangeRate;
  const billed = toDop(d.subtotal, rate);
  const itbis = toDop(d.totalTax, rate);
  const tip = toDop(d.propinaAmount, rate);
  const total = billed + itbis + tip;

  const buckets = { cash: 0n, bankTransfer: 0n, card: 0n, credit: 0n, otherForms: 0n };
  for (const p of d.payments) {
    const v = toDop(p.amount, rate);
    if (p.method === "CASH") buckets.cash += v;
    else if (p.method === "TRANSFER" || p.method === "CHECK") buckets.bankTransfer += v;
    else if (p.method === "CARD") buckets.card += v;
    else if (p.method === "CREDIT") buckets.credit += v;
    else buckets.otherForms += v;
  }
  // Lo pagado debe sumar el total del comprobante: el vuelto sale del efectivo, lo que falta es venta a crédito, y la
  // diferencia de centavos por convertir dólares se absorbe en la forma de pago más grande.
  const paid = Object.values(buckets).reduce((a, b) => a + b, 0n);
  const diff = total - paid;
  if (diff !== 0n) {
    const rounding = diff > -6n && diff < 6n && d.currency !== "DOP";
    if (rounding) {
      const biggest = (Object.keys(buckets) as (keyof typeof buckets)[]).reduce((a, b) => (buckets[b] > buckets[a] ? b : a));
      buckets[biggest] += diff;
    } else if (diff > 0n) buckets.credit += diff;
    else if (buckets.cash >= -diff) buckets.cash += diff;
  }

  const modifies = d.type === "E33" || d.type === "E34";
  return {
    ref: d.encf ?? d.id,
    buyerId: d.buyerDocNumber ?? "",
    idType: d.buyerDocType ? (ID_TYPE_607[d.buyerDocType] ?? null) : null,
    ncf: d.encf ?? "",
    modifiedNcf: modifies ? d.referencedEncf : null,
    incomeType: 1,
    date: localDate(d.issuedAt!),
    withholdingDate: null,
    billed,
    itbis,
    itbisWithheldByThirds: 0n,
    isrWithheldByThirds: 0n,
    selective: 0n,
    otherTaxes: 0n,
    tip,
    ...buckets,
    giftVouchers: 0n,
    swap: 0n,
  };
}

// ───────────── 608 ─────────────

type AnnulmentData = Prisma.SequenceAnnulmentGetPayload<object>;

/** Tipo de anulación de los números que nunca se usaron: «Errores en secuencia de NCF». */
export const UNUSED_RANGE_ANNULMENT_TYPE = 8;
/** No se arma un rango más grande que esto (el formato admite menos): el archivo se marca con error de todos modos. */
const MAX_EXPANDED = 5_000;

export function rows608(a: AnnulmentData): Row608[] {
  const date = localDate(a.completedAt ?? a.createdAt);
  const rows: Row608[] = [];
  for (let n = a.fromNumber; n <= a.toNumber && rows.length < MAX_EXPANDED; n++) {
    const ncf = formatEncf(a.ecfType as AnyEcfType, n);
    rows.push({ ref: ncf, ncf, date, type: UNUSED_RANGE_ANNULMENT_TYPE });
  }
  return rows;
}

// ───────────── Todo junto ─────────────

export type Preview = {
  format: FormatCode;
  period: string;
  filename: string;
  /** Nombres de las columnas, en el orden del archivo. */
  columns: string[];
  rows: string[][];
  count: number;
  errors: FormatFile["errors"];
  warnings: string[];
  totals: Record<string, string>;
  /** 607: lo que se escribe a mano en el «Resumen General de Facturas de Consumo» de la Oficina Virtual. */
  consumerSummary?: { count: number; billed: string; listedInFile: number; belowThreshold: { count: number; billed: string } };
  /** Se puede enviar: sin errores. */
  ready: boolean;
  file: FormatFile;
};

export const COLUMNS: Record<FormatCode, string[]> = {
  606: [
    "RNC/Cédula", "Tipo Id", "Tipo de bienes y servicios", "NCF", "NCF modificado", "Fecha comprobante", "Fecha pago",
    "Monto en servicios", "Monto en bienes", "Total facturado", "ITBIS facturado", "ITBIS retenido", "ITBIS proporcionalidad",
    "ITBIS al costo", "ITBIS por adelantar", "ITBIS percibido", "Tipo retención ISR", "Retención renta", "ISR percibido",
    "Selectivo", "Otros impuestos", "Propina legal", "Forma de pago",
  ],
  607: [
    "RNC/Cédula/Pasaporte", "Tipo Id", "NCF", "NCF modificado", "Tipo de ingreso", "Fecha comprobante", "Fecha retención",
    "Monto facturado", "ITBIS facturado", "ITBIS retenido por terceros", "ITBIS percibido", "Retención renta por terceros",
    "ISR percibido", "Selectivo", "Otros impuestos", "Propina legal", "Efectivo", "Cheque/Transferencia/Depósito",
    "Tarjeta", "Venta a crédito", "Bonos o certificados", "Permuta", "Otras formas",
  ],
  608: ["NCF", "Fecha comprobante", "Tipo de anulación"],
};

const sum = (rows: bigint[]) => rows.reduce((a, b) => a + b, 0n);

/** Arma el formato del período AAAAMM para la empresa de `rnc`, con la vista previa para el panel. */
export async function previewFormat(tx: Prisma.TransactionClient, format: FormatCode, rnc: string, period: string): Promise<Preview | null> {
  const range = periodRange(period);
  if (!range) return null;
  const warnings: string[] = [];
  const totals: Record<string, string> = {};
  let file: FormatFile;
  let consumerSummary: Preview["consumerSummary"];

  if (format === 606) {
    const where = { invoiceDate: { gte: new Date(`${range.from}T00:00:00Z`), lte: new Date(`${range.to}T00:00:00Z`) } };
    const purchases = await tx.purchase.findMany({ where: { ...where, status: "POSTED" }, orderBy: [{ invoiceDate: "asc" }, { ncf: "asc" }] });
    const drafts = await tx.purchase.count({ where: { ...where, status: "DRAFT" } });
    if (drafts > 0) warnings.push(`Hay ${drafts} compra(s) en borrador de este período que no se incluyen: regístralas primero.`);
    const rows = purchases.map(row606);
    if (purchases.some((p) => p.paymentMethod === "OTHER")) warnings.push("Hay compras con forma de pago «Otro»: se informan como «Mixto»; corrígelo si no es así.");
    file = build606({ rnc, period, rows });
    totals["Total facturado"] = fromCents(sum(rows.map((r) => r.services + r.goods)));
    totals["ITBIS facturado"] = fromCents(sum(rows.map((r) => r.itbis)));
    totals["ITBIS retenido"] = fromCents(sum(rows.map((r) => r.itbisWithheld)));
    totals["Retención de renta"] = fromCents(sum(rows.map((r) => r.isrWithheld)));
  } else if (format === 607) {
    const docs = await tx.document.findMany({
      where: { type: { in: [...SALE_TYPES] }, status: { notIn: ["DRAFT", "REJECTED"] }, issuedAt: { gte: range.start, lt: range.end } },
      include: { payments: true },
      orderBy: [{ issuedAt: "asc" }, { encf: "asc" }],
    });
    const rejected = await tx.document.count({ where: { type: { in: [...SALE_TYPES] }, status: "REJECTED", issuedAt: { gte: range.start, lt: range.end } } });
    if (rejected > 0) warnings.push(`Hay ${rejected} comprobante(s) rechazados por la DGII en este período: no se incluyen.`);
    const all = docs.map((d) => ({ doc: d, row: row607(d) }));
    // Las facturas de consumo menores de RD$250,000 no van en el archivo: se resumen en la Oficina Virtual.
    const small = all.filter(({ doc, row }) => doc.type === "E32" && row.billed + row.itbis + row.tip < CONSUMER_INVOICE_LISTING_THRESHOLD);
    const listed = all.filter((x) => !small.includes(x));
    const consumo = all.filter(({ doc }) => doc.type === "E32");
    const bill = (xs: typeof all) => fromCents(sum(xs.map((x) => x.row.billed)));
    consumerSummary = { count: consumo.length, billed: bill(consumo), listedInFile: consumo.length - small.length, belowThreshold: { count: small.length, billed: bill(small) } };
    file = build607({ rnc, period, rows: listed.map((x) => x.row) });
    totals["Monto facturado"] = bill(listed);
    totals["ITBIS facturado"] = fromCents(sum(listed.map((x) => x.row.itbis)));
    warnings.push("Las retenciones que te hicieron terceros (ITBIS e ISR) todavía no se registran en el sistema: si te retuvieron, agrégalas al archivo con tu contador.");
  } else {
    const anns = await tx.sequenceAnnulment.findMany({ where: { state: "DONE", completedAt: { gte: range.start, lt: range.end } }, orderBy: { completedAt: "asc" } });
    const rows = anns.flatMap(rows608);
    file = build608({ rnc, period, rows });
    totals["Comprobantes anulados"] = String(rows.length);
    if (anns.length > 0) warnings.push("Los números de rangos anulados (ANECF) nunca se usaron: se informan con el tipo 08 «Errores en secuencia de NCF» y la fecha en que la DGII confirmó la anulación.");
  }

  const lines = file.text.split("\r\n").slice(1).filter(Boolean);
  return {
    format,
    period,
    filename: file.filename,
    columns: COLUMNS[format],
    rows: lines.map((l) => l.split("|")),
    count: file.count,
    errors: file.errors,
    warnings,
    totals,
    consumerSummary,
    ready: file.errors.length === 0,
    file,
  };
}

export type { Cents };
