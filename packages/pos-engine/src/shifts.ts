import { fromCents, toCents } from "@facturacion/core";
import { SaleError, salePayload, totalsOfPayload, type PaymentMethod, type SaleCtx } from "./sales";
import { all, one, run, transaction, type Db } from "./store";

/** Turno de la caja tal como lo ve la pantalla. */
export type LocalShift = {
  id: string;
  openedAt: string;
  openedBy: { id: string | null; name: string | null };
  openingAmount: string;
  closedAt: string | null;
  countedCash: string | null;
  expectedCash: string | null;
  difference: string | null;
  notes: string | null;
  /** El turno (y su cierre) ya está en la nube. */
  synced: boolean;
  /** Motivo por el que la nube no lo aceptó (p. ej. ya hay un turno abierto allí). */
  syncError: string | null;
};

export type ShiftReport = {
  documents: number;
  byType: Record<"E31" | "E32" | "E34", { count: number; total: string }>;
  sales: { subtotal: string; tax: string; propina: string; total: string };
  credits: string;
  net: string;
  /** Cobrado por forma de pago, ya descontado lo devuelto. */
  payments: Partial<Record<PaymentMethod, string>>;
  cashReceived: string;
  openingAmount: string;
  expectedCash: string;
  countedCash?: string;
  difference?: string;
};

type ShiftRow = {
  id: string;
  opened_at: string;
  opened_by: string | null;
  opening_cents: number;
  closed_at: string | null;
  closed_by: string | null;
  counted_cents: number | null;
  expected_cents: number | null;
  difference_cents: number | null;
  notes: string | null;
  open_synced: number;
  close_synced: number;
  last_error: string | null;
};

const m = (cents: number | null) => (cents === null ? null : fromCents(BigInt(cents)));

function shiftOf(db: Db, r: ShiftRow): LocalShift {
  const name = r.opened_by ? one<{ name: string }>(db, "SELECT name FROM cashier WHERE user_id = ?", r.opened_by)?.name ?? null : null;
  return {
    id: r.id,
    openedAt: r.opened_at,
    openedBy: { id: r.opened_by, name },
    openingAmount: m(r.opening_cents)!,
    closedAt: r.closed_at,
    countedCash: m(r.counted_cents),
    expectedCash: m(r.expected_cents),
    difference: m(r.difference_cents),
    notes: r.notes,
    synced: r.open_synced === 1 && (r.closed_at === null || r.close_synced === 1),
    syncError: r.last_error,
  };
}

export function currentShift(db: Db): LocalShift | null {
  const r = one<ShiftRow>(db, "SELECT * FROM shift WHERE closed_at IS NULL");
  return r ? shiftOf(db, r) : null;
}
export function listShifts(db: Db, limit = 30): LocalShift[] {
  return all<ShiftRow>(db, "SELECT * FROM shift ORDER BY opened_at DESC LIMIT ?", limit).map((r) => shiftOf(db, r));
}
export function getShift(db: Db, id: string): LocalShift | null {
  const r = one<ShiftRow>(db, "SELECT * FROM shift WHERE id = ?", id);
  return r ? shiftOf(db, r) : null;
}

/** Abre el turno con el fondo de la gaveta. Solo puede haber uno abierto en esta caja. */
export function openShift(db: Db, ctx: Pick<SaleCtx, "now" | "newId" | "cashierId">, openingAmount: string): LocalShift {
  let cents: bigint;
  try {
    cents = toCents(openingAmount || "0");
  } catch {
    throw new SaleError("El fondo de caja es inválido");
  }
  if (cents < 0n) throw new SaleError("El fondo de caja no puede ser negativo");
  const id = (ctx.newId ?? (() => crypto.randomUUID()))();
  return transaction(db, () => {
    if (currentShift(db)) throw new SaleError("Esta caja ya tiene un turno abierto");
    run(
      db,
      "INSERT INTO shift (id, opened_at, opened_by, opening_cents) VALUES (?, ?, ?, ?)",
      id,
      (ctx.now ?? new Date()).toISOString(),
      ctx.cashierId ?? null,
      Number(cents),
    );
    return getShift(db, id)!;
  });
}

/**
 * Informe del turno (X mientras está abierto, Z al cerrarlo), calculado con las ventas de ESTA caja. Mismas reglas que
 * el de la nube: las ventas rechazadas no cuentan; las notas de crédito restan y su reembolso baja la forma de pago
 * en que se devolvió (el efectivo devuelto baja el efectivo esperado).
 */
export function shiftReport(db: Db, shiftId: string): ShiftReport & { expectedCents: bigint } {
  const shift = one<ShiftRow>(db, "SELECT * FROM shift WHERE id = ?", shiftId);
  if (!shift) throw new SaleError("Turno no encontrado");
  const sales = all<{ id: string }>(db, "SELECT id FROM sale WHERE shift_id = ? AND status <> 'REJECTED' ORDER BY created_at", shiftId);

  const byType = { E31: { count: 0, total: 0n }, E32: { count: 0, total: 0n }, E34: { count: 0, total: 0n } };
  const byMethod = new Map<PaymentMethod, bigint>();
  let subtotal = 0n;
  let tax = 0n;
  let propina = 0n;
  let salesTotal = 0n;
  let credits = 0n;
  for (const { id } of sales) {
    const p = salePayload(db, id)!;
    const t = totalsOfPayload(p);
    byType[p.type].count++;
    byType[p.type].total += t.total;
    const sign = p.type === "E34" ? -1n : 1n;
    if (p.type === "E34") credits += t.total;
    else {
      salesTotal += t.total;
      subtotal += t.subtotal;
      tax += t.totalTax;
      propina += t.propinaLegal;
    }
    for (const pay of p.payments) byMethod.set(pay.method, (byMethod.get(pay.method) ?? 0n) + sign * toCents(pay.amount));
  }
  const cash = byMethod.get("CASH") ?? 0n;
  const expected = BigInt(shift.opening_cents) + cash;
  return {
    documents: sales.length,
    byType: {
      E31: { count: byType.E31.count, total: fromCents(byType.E31.total) },
      E32: { count: byType.E32.count, total: fromCents(byType.E32.total) },
      E34: { count: byType.E34.count, total: fromCents(byType.E34.total) },
    },
    sales: { subtotal: fromCents(subtotal), tax: fromCents(tax), propina: fromCents(propina), total: fromCents(salesTotal) },
    credits: fromCents(credits),
    net: fromCents(salesTotal - credits),
    payments: Object.fromEntries([...byMethod].sort().map(([k, v]) => [k, fromCents(v)])),
    cashReceived: fromCents(cash),
    openingAmount: fromCents(BigInt(shift.opening_cents)),
    expectedCash: fromCents(expected),
    ...(shift.closed_at ? { countedCash: m(shift.counted_cents)!, difference: m(shift.difference_cents)! } : {}),
    expectedCents: expected,
  };
}

/** Cierra el turno contando el efectivo. Si no cuadra, exige el motivo. Devuelve el informe Z. */
export function closeShift(
  db: Db,
  ctx: Pick<SaleCtx, "now" | "cashierId">,
  input: { countedCash: string; notes?: string | null },
): { shift: LocalShift; report: ShiftReport } {
  let counted: bigint;
  try {
    counted = toCents(input.countedCash);
  } catch {
    throw new SaleError("El efectivo contado es inválido");
  }
  if (counted < 0n) throw new SaleError("El efectivo contado no puede ser negativo");
  const open = currentShift(db);
  if (!open) throw new SaleError("No hay un turno abierto en esta caja");

  return transaction(db, () => {
    const { expectedCents, ...rest } = shiftReport(db, open.id);
    const difference = counted - expectedCents;
    const notes = input.notes?.trim() || null;
    if (difference !== 0n && !notes) {
      throw new SaleError("El efectivo contado no coincide con el esperado: indica el motivo de la diferencia");
    }
    run(
      db,
      `UPDATE shift SET closed_at = ?, closed_by = ?, counted_cents = ?, expected_cents = ?, difference_cents = ?, notes = ? WHERE id = ?`,
      (ctx.now ?? new Date()).toISOString(),
      ctx.cashierId ?? null,
      Number(counted),
      Number(expectedCents),
      Number(difference),
      notes,
      open.id,
    );
    return {
      shift: getShift(db, open.id)!,
      report: { ...rest, countedCash: fromCents(counted), difference: fromCents(difference) },
    };
  });
}

/** Informe de un turno (X si sigue abierto, Z si ya se cerró). */
export function reportOfShift(db: Db, id: string): { shift: LocalShift; report: ShiftReport } | null {
  const shift = getShift(db, id);
  if (!shift) return null;
  const { expectedCents: _ignored, ...report } = shiftReport(db, id);
  return { shift, report };
}
