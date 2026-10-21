import {
  buyerErrors,
  calculateDocument,
  DOCUMENT_TYPES,
  formatDop,
  formatEncf,
  fromCents,
  fromMilli,
  toCents,
  toMilli,
  type DocumentType,
  type LineInput,
  type TaxCode,
} from "@facturacion/core";
import { getCompany, getCustomer, getProduct, type Company } from "./catalog";
import { all, one, run, transaction, type Db } from "./store";

/** Errores que la pantalla muestra tal cual al cajero. */
export class SaleError extends Error {}

export type PaymentMethod = "CASH" | "TRANSFER" | "CHECK" | "CARD" | "OTHER";
export type SaleType = "E31" | "E32" | "E34";

export type SaleInput = {
  type: "E31" | "E32";
  customerId?: string | null;
  /** Comprador sin ficha (consumidor final con documento). */
  buyer?: { name?: string | null; docType?: DocumentType | null; docNumber?: string | null } | null;
  propinaLegal?: boolean;
  notes?: string | null;
  lines: { productId: string; quantity: string }[];
  payments: { method: PaymentMethod; amount: string }[];
};

/** Lo que se sube a la nube: un reflejo exacto de lo que se imprimió. */
export type SalePayload = {
  clientId: string;
  terminalId: string;
  type: SaleType;
  encf: string;
  issuedAt: string;
  /** Quién vendió (identificado con su PIN). */
  cashierId: string | null;
  /** Turno de la caja en el que se vendió. */
  shiftClientId: string | null;
  customerId: string | null;
  buyer: SaleInput["buyer"] | null;
  propinaLegal: boolean;
  notes: string | null;
  /** Solo notas de crédito. */
  referencedEncf?: string | null;
  modificationCode?: number | null;
  returnsStock?: boolean;
  lines: {
    productId: string;
    name: string;
    quantity: string;
    unitPrice: string;
    tax: string;
    priceIncludesTax: boolean;
  }[];
  /** En una nota de crédito son el reembolso. */
  payments: { method: PaymentMethod; amount: string }[];
  total: string;
};

export type LocalSale = {
  id: string;
  encf: string;
  type: SaleType;
  issuedAt: string;
  total: string;
  status: "PENDING" | "SYNCED" | "REJECTED";
  attempts: number;
  lastError: string | null;
  syncedAt: string | null;
  /** e-NCF que modifica (solo notas de crédito). */
  refundOf: string | null;
};

/** Todo lo necesario para imprimir el ticket (sin volver a calcular nada). */
export type Receipt = {
  sale: LocalSale;
  company: Company | null;
  buyerName: string | null;
  buyerDoc: string | null;
  lines: { name: string; quantity: string; unitPrice: string; total: string }[];
  totals: { subtotal: string; tax: string; propina: string; total: string };
  payments: { method: PaymentMethod; amount: string }[];
  cashierName: string | null;
};

export type SaleCtx = {
  terminalId: string;
  now?: Date;
  newId?: () => string;
  cashierId?: string | null;
  cashierName?: string | null;
  shiftId?: string | null;
};

export const todayDr = (now: Date) => new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Santo_Domingo" }).format(now);

/** Toma el siguiente número del bloque vigente que vence primero. Debe llamarse dentro de una transacción. */
export function takeEncf(db: Db, type: SaleType, now: Date): string {
  const row = one<{ n: number }>(
    db,
    `UPDATE seq_block SET next_number = next_number + 1
     WHERE id = (
       SELECT id FROM seq_block
       WHERE ecf_type = ? AND next_number <= to_number AND expires_at >= ?
       ORDER BY expires_at, from_number LIMIT 1
     )
     RETURNING next_number - 1 AS n`,
    type,
    todayDr(now),
  );
  if (!row) {
    throw new SaleError(`No quedan números de ${type} en esta caja. Conéctate a internet para pedir un bloque nuevo.`);
  }
  return formatEncf(type, BigInt(row.n));
}

const lineInputOf = (l: SalePayload["lines"][number]): LineInput => ({
  unitPrice: toCents(l.unitPrice),
  quantity: toMilli(l.quantity),
  tax: l.tax as TaxCode,
  priceIncludesTax: l.priceIncludesTax,
});

/** Totales de un comprobante, con el mismo motor que usa la nube. */
export const totalsOfPayload = (payload: Pick<SalePayload, "lines" | "propinaLegal">) =>
  calculateDocument({ lines: payload.lines.map(lineInputOf), propinaLegal: payload.propinaLegal });

/** Guarda una venta (o nota de crédito) ya validada, con su e-NCF, dentro de la transacción del llamador. */
export function insertSale(db: Db, ctx: SaleCtx, payload: SalePayload, createdAt: Date) {
  run(
    db,
    `INSERT INTO sale (id, encf, type, issued_at, total_cents, payload, status, created_at, shift_id, cashier_id, refund_of)
     VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?)`,
    payload.clientId,
    payload.encf,
    payload.type,
    payload.issuedAt,
    Number(toCents(payload.total)),
    JSON.stringify(payload),
    createdAt.toISOString(),
    ctx.shiftId ?? null,
    payload.cashierId,
    payload.referencedEncf ?? null,
  );
}

/**
 * Registra una venta en la caja, sin internet: calcula con el mismo motor fiscal de la nube, valida las reglas del
 * comprador y los pagos, toma el e-NCF del bloque local y deja la venta lista para subirse. Todo en UNA transacción:
 * si algo falla no se gasta ningún número.
 */
export function createSale(db: Db, ctx: SaleCtx, input: SaleInput): Receipt {
  const now = ctx.now ?? new Date();
  const id = (ctx.newId ?? (() => crypto.randomUUID()))();

  if (input.lines.length === 0) throw new SaleError("Agrega al menos un producto");

  // Líneas con el precio e impuesto de HOY del catálogo local: lo que se imprime es lo que se sube.
  const resolved = input.lines.map((l) => {
    const p = getProduct(db, l.productId);
    if (!p || !p.active) throw new SaleError("Un producto del carrito ya no está disponible");
    let qty: bigint;
    try {
      qty = toMilli(l.quantity);
    } catch {
      throw new SaleError(`Cantidad inválida para "${p.name}"`);
    }
    if (qty <= 0n) throw new SaleError(`La cantidad de "${p.name}" debe ser mayor que cero`);
    if (!p.allowsDecimals && qty % 1000n !== 0n) throw new SaleError(`"${p.name}" no se vende en fracciones`);
    return { p, qty };
  });
  const lines: SalePayload["lines"] = resolved.map(({ p, qty }) => ({
    productId: p.id,
    name: p.name,
    quantity: fromMilli(qty),
    unitPrice: fromCents(BigInt(p.priceCents)),
    tax: p.tax,
    priceIncludesTax: p.priceIncludesTax,
  }));
  const propinaLegal = input.propinaLegal ?? false;
  const totals = totalsOfPayload({ lines, propinaLegal });
  if (totals.total <= 0n) throw new SaleError("El total debe ser mayor que cero");

  // Comprador.
  const customer = input.customerId ? getCustomer(db, input.customerId) : null;
  if (input.customerId && !customer) throw new SaleError("El cliente ya no existe en la caja: sincroniza e inténtalo de nuevo");
  const buyer = customer
    ? {
        name: customer.name,
        docType:
          customer.documentType && (DOCUMENT_TYPES as readonly string[]).includes(customer.documentType)
            ? (customer.documentType as DocumentType)
            : null,
        docNumber: customer.documentNumber,
      }
    : { name: input.buyer?.name ?? null, docType: input.buyer?.docType ?? null, docNumber: input.buyer?.docNumber ?? null };
  const [problem] = buyerErrors(input.type, totals.total, { docType: buyer.docType, docNumber: buyer.docNumber });
  if (problem) throw new SaleError(problem);

  const payments = checkPayments(input.payments, totals.total, "Los pagos");

  return transaction(db, () => {
    const encf = takeEncf(db, input.type, now);
    const payload: SalePayload = {
      clientId: id,
      terminalId: ctx.terminalId,
      type: input.type,
      encf,
      issuedAt: now.toISOString(),
      cashierId: ctx.cashierId ?? null,
      shiftClientId: ctx.shiftId ?? null,
      customerId: customer?.id ?? null,
      buyer: customer ? null : (input.buyer ?? null),
      propinaLegal,
      notes: input.notes ?? null,
      lines,
      payments,
      total: fromCents(totals.total),
    };
    insertSale(db, ctx, payload, now);
    return receiptOf(db, id, buyer, ctx.cashierName ?? null);
  });
}

/** Valida los montos de pago (positivos y que sumen el total) y los normaliza a "123.45". */
export function checkPayments(input: SaleInput["payments"], total: bigint, label: string) {
  let paid = 0n;
  const out = input.map((p) => {
    let amount: bigint;
    try {
      amount = toCents(p.amount);
    } catch {
      throw new SaleError("Un monto de pago es inválido");
    }
    if (amount <= 0n) throw new SaleError(`${label} deben ser mayores que cero`);
    paid += amount;
    return { method: p.method, amount: fromCents(amount) };
  });
  if (paid !== total) {
    throw new SaleError(`${label} (${formatDop(paid)}) deben sumar el total (${formatDop(total)})`);
  }
  return out;
}

type SaleRow = {
  id: string;
  encf: string;
  type: SaleType;
  issued_at: string;
  total_cents: number;
  status: "PENDING" | "SYNCED" | "REJECTED";
  attempts: number;
  last_error: string | null;
  synced_at: string | null;
  refund_of: string | null;
};
const saleOf = (r: SaleRow): LocalSale => ({
  id: r.id,
  encf: r.encf,
  type: r.type,
  issuedAt: r.issued_at,
  total: fromCents(BigInt(r.total_cents)),
  status: r.status,
  attempts: r.attempts,
  lastError: r.last_error,
  syncedAt: r.synced_at,
  refundOf: r.refund_of,
});

export function getSale(db: Db, id: string): LocalSale | null {
  const r = one<SaleRow>(db, "SELECT * FROM sale WHERE id = ?", id);
  return r ? saleOf(r) : null;
}

export function listSales(db: Db, opts: { status?: LocalSale["status"]; limit?: number } = {}): LocalSale[] {
  return all<SaleRow>(
    db,
    "SELECT * FROM sale WHERE (? IS NULL OR status = ?) ORDER BY created_at DESC, encf DESC LIMIT ?",
    opts.status ?? null,
    opts.status ?? null,
    opts.limit ?? 50,
  ).map(saleOf);
}

export const salePayload = (db: Db, id: string): SalePayload | null => {
  const row = one<{ payload: string }>(db, "SELECT payload FROM sale WHERE id = ?", id);
  return row ? (JSON.parse(row.payload) as SalePayload) : null;
};

/** El comprobante tal como se imprimió, reconstruido desde lo guardado (para reimprimir). */
export function receiptOfSale(db: Db, id: string): Receipt | null {
  const payload = salePayload(db, id);
  if (!payload) return null;
  const customer = payload.customerId ? getCustomer(db, payload.customerId) : null;
  const cashier = payload.cashierId
    ? one<{ name: string }>(db, "SELECT name FROM cashier WHERE user_id = ?", payload.cashierId)
    : undefined;
  return receiptOf(
    db,
    id,
    { name: customer?.name ?? payload.buyer?.name ?? null, docNumber: customer?.documentNumber ?? payload.buyer?.docNumber ?? null },
    cashier?.name ?? null,
  );
}

function receiptOf(db: Db, id: string, buyer: { name: string | null; docNumber: string | null }, cashierName: string | null): Receipt {
  const payload = salePayload(db, id)!;
  const totals = totalsOfPayload(payload);
  return {
    sale: getSale(db, id)!,
    company: getCompany(db),
    buyerName: buyer.name,
    buyerDoc: buyer.docNumber,
    lines: totals.lines.map((l, i) => ({
      name: payload.lines[i]!.name,
      quantity: payload.lines[i]!.quantity,
      unitPrice: payload.lines[i]!.unitPrice,
      total: fromCents(l.total),
    })),
    totals: {
      subtotal: fromCents(totals.subtotal),
      tax: fromCents(totals.totalTax),
      propina: fromCents(totals.propinaLegal),
      total: fromCents(totals.total),
    },
    payments: payload.payments,
    cashierName,
  };
}
