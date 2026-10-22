import { fromCents, fromMilli, toMilli } from "@facturacion/core";
import {
  checkPayments,
  insertSale,
  receiptOfSale,
  salePayload,
  SaleError,
  signLocally,
  takeEncf,
  totalsOfPayload,
  type PaymentMethod,
  type Receipt,
  type SaleCtx,
  type SalePayload,
} from "./sales";
import { all, one, transaction, type Db } from "./store";

/** Una línea de una venta, con lo que ya se devolvió y lo que aún se puede devolver. */
export type ReturnableLine = {
  /** Posición en la venta original (sirve para elegir qué devolver). */
  index: number;
  productId: string;
  name: string;
  unitPrice: string;
  tax: string;
  priceIncludesTax: boolean;
  sold: string;
  returned: string;
  remaining: string;
};

export type RefundInput = {
  /** Venta (id local) que se devuelve. */
  saleId: string;
  /** Qué devolver. Sin `items`: todo lo que falte por devolver. */
  items?: { index: number; quantity: string }[];
  /** Forma en que se le devuelve el dinero al cliente. */
  method: PaymentMethod;
  /** La mercancía vuelve al inventario (por defecto sí). Si se anula la venta completa, el inventario se repone siempre. */
  returnsStock?: boolean;
  notes?: string | null;
};

const keyOf = (l: { productId: string; unitPrice: string; tax: string }) => `${l.productId}|${l.unitPrice}|${l.tax}`;

/** Notas de crédito de esta caja que ya modifican un comprobante (las rechazadas por la nube no cuentan). */
function creditNotesOf(db: Db, encf: string): SalePayload[] {
  return all<{ id: string }>(db, "SELECT id FROM sale WHERE type = 'E34' AND refund_of = ? AND status <> 'REJECTED'", encf)
    .map((r) => salePayload(db, r.id)!)
    .filter(Boolean);
}

/** Qué se puede devolver de una venta, línea por línea. */
export function returnableLines(
  db: Db,
  saleId: string,
): { encf: string; propinaLegal: boolean; lines: ReturnableLine[]; hasCredit: boolean } {
  const payload = salePayload(db, saleId);
  if (!payload || payload.type === "E34") throw new SaleError("Esa venta no se puede devolver");
  const returned = new Map<string, bigint>();
  const notes = creditNotesOf(db, payload.encf);
  for (const note of notes) {
    for (const l of note.lines) returned.set(keyOf(l), (returned.get(keyOf(l)) ?? 0n) + toMilli(l.quantity));
  }
  // Si hay varias líneas iguales (mismo producto, precio e impuesto), lo devuelto se reparte en orden.
  const left = new Map(returned);
  const lines = payload.lines.map((l, index) => {
    const sold = toMilli(l.quantity);
    const available = left.get(keyOf(l)) ?? 0n;
    const done = available < sold ? available : sold;
    left.set(keyOf(l), available - done);
    return {
      index,
      productId: l.productId,
      name: l.name,
      unitPrice: l.unitPrice,
      tax: l.tax,
      priceIncludesTax: l.priceIncludesTax,
      sold: fromMilli(sold),
      returned: fromMilli(done),
      remaining: fromMilli(sold - done),
    };
  });
  return { encf: payload.encf, propinaLegal: payload.propinaLegal, lines, hasCredit: notes.length > 0 };
}

/**
 * Nota de crédito desde la caja, sin internet: devuelve todo o parte de una venta hecha aquí. Usa el precio, el
 * impuesto y la propina de la venta original (no los de hoy), toma el e-NCF E34 del bloque local y deja el
 * reembolso registrado por forma de pago (el efectivo devuelto baja el efectivo esperado del turno).
 */
export function createRefund(db: Db, ctx: SaleCtx, input: RefundInput): Receipt {
  const now = ctx.now ?? new Date();
  const id = (ctx.newId ?? (() => crypto.randomUUID()))();

  const row = one<{ id: string; status: string }>(db, "SELECT id, status FROM sale WHERE id = ?", input.saleId);
  if (!row) throw new SaleError("No se encontró la venta");
  if (row.status === "REJECTED") throw new SaleError("Esa venta fue rechazada por la nube y nunca se emitió: no se puede devolver");
  const original = salePayload(db, input.saleId)!;
  if (original.type === "E34") throw new SaleError("Una nota de crédito no se puede devolver");

  const { lines: returnable, hasCredit } = returnableLines(db, input.saleId);
  const wanted = input.items ?? returnable.filter((l) => toMilli(l.remaining) > 0n).map((l) => ({ index: l.index, quantity: l.remaining }));
  if (wanted.length === 0) throw new SaleError("Esa venta ya se devolvió completa");

  const seen = new Set<number>();
  const lines: SalePayload["lines"] = wanted.map((w) => {
    const line = returnable[w.index];
    if (!line || seen.has(w.index)) throw new SaleError("Una línea a devolver no es válida");
    seen.add(w.index);
    let qty: bigint;
    try {
      qty = toMilli(w.quantity);
    } catch {
      throw new SaleError(`Cantidad inválida para "${line.name}"`);
    }
    if (qty <= 0n) throw new SaleError(`La cantidad de "${line.name}" debe ser mayor que cero`);
    if (qty > toMilli(line.remaining)) throw new SaleError(`De "${line.name}" solo se pueden devolver ${line.remaining}`);
    const source = original.lines[w.index]!;
    return { ...source, quantity: fromMilli(qty) };
  });

  // ¿Se anula todo? Solo si no hay otras notas y se devuelve cada línea completa: entonces es el código 1
  // (anula el comprobante), que la nube respalda reponiendo el inventario de lo vendido.
  const full =
    !hasCredit &&
    returnable.length === lines.length &&
    returnable.every((r) => lines.some((l) => l.productId === r.productId && toMilli(l.quantity) === toMilli(r.sold)));

  const totals = totalsOfPayload({ lines, propinaLegal: original.propinaLegal });
  if (totals.total <= 0n) throw new SaleError("El total a devolver debe ser mayor que cero");
  const payments = checkPayments([{ method: input.method, amount: fromCents(totals.total) }], totals.total, "El reembolso");

  return transaction(db, () => {
    const encf = takeEncf(db, "E34", now);
    const payload: SalePayload = {
      clientId: id,
      terminalId: ctx.terminalId,
      type: "E34",
      encf,
      issuedAt: now.toISOString(),
      cashierId: ctx.cashierId ?? null,
      shiftClientId: ctx.shiftId ?? null,
      customerId: original.customerId,
      buyer: original.buyer,
      propinaLegal: original.propinaLegal,
      notes: input.notes ?? null,
      referencedEncf: original.encf,
      modificationCode: full ? 1 : 3,
      returnsStock: full ? false : (input.returnsStock ?? true),
      lines,
      payments,
      total: fromCents(totals.total),
    };
    insertSale(db, ctx, payload, now);
    const warning = signLocally(db, ctx, id, payload);
    return { ...receiptOfSale(db, id)!, signWarning: warning };
  });
}
