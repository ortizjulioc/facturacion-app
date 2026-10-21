import {
  buyerErrors,
  calculateDocument,
  formatDop,
  formatEncf,
  fromCents,
  fromMilli,
  DOCUMENT_TYPES,
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
  type: "E31" | "E32";
  encf: string;
  issuedAt: string;
  customerId: string | null;
  buyer: SaleInput["buyer"] | null;
  propinaLegal: boolean;
  notes: string | null;
  lines: {
    productId: string;
    name: string;
    quantity: string;
    unitPrice: string;
    tax: string;
    priceIncludesTax: boolean;
  }[];
  payments: { method: PaymentMethod; amount: string }[];
  total: string;
};

export type LocalSale = {
  id: string;
  encf: string;
  type: "E31" | "E32";
  issuedAt: string;
  total: string;
  status: "PENDING" | "SYNCED" | "REJECTED";
  attempts: number;
  lastError: string | null;
  syncedAt: string | null;
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
};

const todayDr = (now: Date) => new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Santo_Domingo" }).format(now);

/** Toma el siguiente número del bloque vigente que vence primero. Debe llamarse dentro de una transacción. */
function takeEncf(db: Db, type: "E31" | "E32", now: Date): string {
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
    throw new SaleError(
      `No quedan números de ${type} en esta caja. Conéctate a internet para pedir un bloque nuevo.`,
    );
  }
  return formatEncf(type, BigInt(row.n));
}

/**
 * Registra una venta en la caja, sin internet: calcula con el mismo motor fiscal de la nube, valida las reglas del
 * comprador y los pagos, toma el e-NCF del bloque local y deja la venta lista para subirse. Todo en UNA transacción:
 * si algo falla no se gasta ningún número.
 */
export function createSale(
  db: Db,
  ctx: { terminalId: string; now?: Date; newId?: () => string },
  input: SaleInput,
): Receipt {
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
  const lineInputs: LineInput[] = resolved.map(({ p, qty }) => ({
    unitPrice: BigInt(p.priceCents),
    quantity: qty,
    tax: p.tax as TaxCode,
    priceIncludesTax: p.priceIncludesTax,
  }));
  const propinaLegal = input.propinaLegal ?? false;
  const totals = calculateDocument({ lines: lineInputs, propinaLegal });
  if (totals.total <= 0n) throw new SaleError("El total debe ser mayor que cero");

  // Comprador.
  const customer = input.customerId ? getCustomer(db, input.customerId) : null;
  if (input.customerId && !customer) throw new SaleError("El cliente ya no existe en la caja: sincroniza e inténtalo de nuevo");
  const buyer = customer
    ? {
        name: customer.name,
        docType: customer.documentType && (DOCUMENT_TYPES as readonly string[]).includes(customer.documentType) ? (customer.documentType as DocumentType) : null,
        docNumber: customer.documentNumber,
      }
    : { name: input.buyer?.name ?? null, docType: input.buyer?.docType ?? null, docNumber: input.buyer?.docNumber ?? null };
  const [problem] = buyerErrors(input.type, totals.total, { docType: buyer.docType, docNumber: buyer.docNumber });
  if (problem) throw new SaleError(problem);

  // Pagos: deben sumar el total.
  let paid = 0n;
  for (const p of input.payments) {
    let amount: bigint;
    try {
      amount = toCents(p.amount);
    } catch {
      throw new SaleError("Un monto de pago es inválido");
    }
    if (amount <= 0n) throw new SaleError("Los pagos deben ser mayores que cero");
    paid += amount;
  }
  if (paid !== totals.total) {
    throw new SaleError(`Los pagos (${formatDop(paid)}) deben sumar el total (${formatDop(totals.total)})`);
  }

  return transaction(db, () => {
    const encf = takeEncf(db, input.type, now);
    const payload: SalePayload = {
      clientId: id,
      terminalId: ctx.terminalId,
      type: input.type,
      encf,
      issuedAt: now.toISOString(),
      customerId: customer?.id ?? null,
      buyer: customer ? null : (input.buyer ?? null),
      propinaLegal,
      notes: input.notes ?? null,
      lines: resolved.map(({ p, qty }) => ({
        productId: p.id,
        name: p.name,
        quantity: fromMilli(qty),
        unitPrice: fromCents(BigInt(p.priceCents)),
        tax: p.tax,
        priceIncludesTax: p.priceIncludesTax,
      })),
      payments: input.payments.map((p) => ({ method: p.method, amount: fromCents(toCents(p.amount)) })),
      total: fromCents(totals.total),
    };
    run(
      db,
      `INSERT INTO sale (id, encf, type, issued_at, total_cents, payload, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?)`,
      id,
      encf,
      input.type,
      payload.issuedAt,
      Number(totals.total),
      JSON.stringify(payload),
      now.toISOString(),
    );
    return receiptOf(db, id, totals, buyer, payload);
  });
}

type Totals = ReturnType<typeof calculateDocument>;

function receiptOf(
  db: Db,
  id: string,
  totals: Totals,
  buyer: { name: string | null; docNumber: string | null },
  payload: SalePayload,
): Receipt {
  const sale = getSale(db, id)!;
  return {
    sale,
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
  };
}

type SaleRow = {
  id: string;
  encf: string;
  type: "E31" | "E32";
  issued_at: string;
  total_cents: number;
  status: "PENDING" | "SYNCED" | "REJECTED";
  attempts: number;
  last_error: string | null;
  synced_at: string | null;
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

/** El comprobante tal como se imprimió, reconstruido desde lo guardado (para reimprimir). */
export function receiptOfSale(db: Db, id: string): Receipt | null {
  const row = one<{ payload: string }>(db, "SELECT payload FROM sale WHERE id = ?", id);
  if (!row) return null;
  const payload = JSON.parse(row.payload) as SalePayload;
  const totals = calculateDocument({
    lines: payload.lines.map((l) => ({
      unitPrice: toCents(l.unitPrice),
      quantity: toMilli(l.quantity),
      tax: l.tax as TaxCode,
      priceIncludesTax: l.priceIncludesTax,
    })),
    propinaLegal: payload.propinaLegal,
  });
  const customer = payload.customerId ? getCustomer(db, payload.customerId) : null;
  return receiptOf(
    db,
    id,
    totals,
    { name: customer?.name ?? payload.buyer?.name ?? null, docNumber: customer?.documentNumber ?? payload.buyer?.docNumber ?? null },
    payload,
  );
}

export const salePayload = (db: Db, id: string): SalePayload | null => {
  const row = one<{ payload: string }>(db, "SELECT payload FROM sale WHERE id = ?", id);
  return row ? (JSON.parse(row.payload) as SalePayload) : null;
};
