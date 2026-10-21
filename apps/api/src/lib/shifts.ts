import { convertCents, fromCents, type Cents } from "@facturacion/core";
import type { TenantTx } from "../types";

/** Cualquier cliente con acceso a `document` (la transacción del tenant o el cliente ya atado a la empresa). */
export type DocumentReader = Pick<TenantTx, "document">;

const DOC_TYPES = ["E31", "E32", "E33", "E34"] as const;

/**
 * Informe del turno (X mientras está abierto, Z al cerrarlo). Reglas, como en los reportes de ventas:
 *  - solo cuentan comprobantes emitidos en la caja durante el turno;
 *  - las notas de crédito (E34) restan y las de débito (E33) suman;
 *  - todo en pesos (los comprobantes en dólares se convierten con su tasa de cambio);
 *  - el efectivo esperado es el fondo de apertura más lo cobrado en efectivo.
 */
export async function shiftReport(db: DocumentReader, shift: { id: string; openingAmount: bigint }) {
  const docs = await db.document.findMany({
    where: { shiftId: shift.id, status: { not: "DRAFT" } },
    select: {
      type: true,
      total: true,
      subtotal: true,
      totalTax: true,
      propinaAmount: true,
      exchangeRate: true,
      payments: { select: { method: true, amount: true } },
    },
  });

  const zero = () => ({ count: 0, total: 0n });
  const byType = Object.fromEntries(DOC_TYPES.map((t) => [t, zero()])) as Record<(typeof DOC_TYPES)[number], ReturnType<typeof zero>>;
  const byMethod = new Map<string, Cents>();
  let subtotal = 0n;
  let tax = 0n;
  let propina = 0n;
  let sales = 0n;
  let credits = 0n;

  for (const d of docs) {
    const rate = d.exchangeRate.toString();
    const total = convertCents(d.total, rate);
    const type = d.type as (typeof DOC_TYPES)[number];
    byType[type].count += 1;
    byType[type].total += total;

    if (type === "E34") {
      credits += total;
      continue;
    }
    sales += total;
    subtotal += convertCents(d.subtotal, rate);
    tax += convertCents(d.totalTax, rate);
    propina += convertCents(d.propinaAmount, rate);
    for (const p of d.payments) {
      byMethod.set(p.method, (byMethod.get(p.method) ?? 0n) + convertCents(p.amount, rate));
    }
  }

  const cash = byMethod.get("CASH") ?? 0n;
  const expectedCash = shift.openingAmount + cash;
  return {
    documents: docs.length,
    byType: Object.fromEntries(
      DOC_TYPES.map((t) => [t, { count: byType[t].count, total: fromCents(byType[t].total) }]),
    ) as Record<(typeof DOC_TYPES)[number], { count: number; total: string }>,
    sales: {
      subtotal: fromCents(subtotal),
      tax: fromCents(tax),
      propina: fromCents(propina),
      total: fromCents(sales),
    },
    credits: fromCents(credits),
    /** Ventas netas del turno: lo vendido (con notas de débito) menos las notas de crédito. */
    net: fromCents(sales - credits),
    payments: Object.fromEntries([...byMethod].sort().map(([k, v]) => [k, fromCents(v)])) as Record<string, string>,
    cashReceived: fromCents(cash),
    openingAmount: fromCents(shift.openingAmount),
    expectedCash: fromCents(expectedCash),
    /** Para cerrar el turno sin volver a convertir. */
    expectedCashCents: expectedCash,
  };
}

export type ShiftReport = Awaited<ReturnType<typeof shiftReport>>;

/** El informe que se guarda congelado al cerrar (sin el campo auxiliar en centavos). */
export const frozenReport = ({ expectedCashCents: _ignored, ...report }: ShiftReport) => report;
