import {
  calculateDocument,
  calculateLine,
  fromCents,
  fromMilli,
  type LineInput,
} from "@facturacion/core";
import type { Prisma } from "@facturacion/db";

export type OrderFull = Prisma.RestaurantOrderGetPayload<{
  include: { items: true; table: true };
}>;
type Item = OrderFull["items"][number];

export const ORDER_INCLUDE = {
  items: { orderBy: { createdAt: "asc" } },
  table: true,
} satisfies Prisma.RestaurantOrderInclude;

const m = (v: bigint) => fromCents(v);

/** Lo que aún falta por cobrar de un producto (0 si está anulado o ya se cobró completo). */
export const remainingOf = (item: Pick<Item, "status" | "quantity" | "billedQuantity">) =>
  item.status === "VOID" ? 0n : item.quantity - item.billedQuantity;

const lineInput = (item: Item, quantity: bigint): LineInput => ({
  unitPrice: item.unitPrice,
  quantity,
  tax: item.tax,
  priceIncludesTax: item.priceIncludesTax,
});

/**
 * Totales de lo que falta por cobrar de la comanda, con y sin propina legal (10 %).
 * Usa el mismo motor que la facturación, así que el total de la pre-cuenta es el que saldrá en la factura.
 */
export function orderTotals(items: Pick<Item, "status" | "quantity" | "billedQuantity" | "unitPrice" | "tax" | "priceIncludesTax">[]) {
  const lines = items
    .map((i) => ({ i, rem: remainingOf(i) }))
    .filter((x) => x.rem > 0n)
    .map(({ i, rem }) => lineInput(i as Item, rem));

  if (lines.length === 0) {
    return { subtotal: "0.00", tax: "0.00", total: "0.00", propina: "0.00", totalWithTip: "0.00" };
  }
  const plain = calculateDocument({ lines });
  const tipped = calculateDocument({ lines, propinaLegal: true });
  return {
    subtotal: m(plain.subtotal),
    tax: m(plain.totalTax),
    total: m(plain.total),
    propina: m(tipped.propinaLegal),
    totalWithTip: m(tipped.total),
  };
}

export const itemDto = (i: Item) => {
  const remaining = remainingOf(i);
  return {
    id: i.id,
    productId: i.productId,
    name: i.name,
    unit: i.unit,
    quantity: fromMilli(i.quantity),
    billedQuantity: fromMilli(i.billedQuantity),
    remaining: fromMilli(remaining),
    unitPrice: m(i.unitPrice),
    priceIncludesTax: i.priceIncludesTax,
    tax: i.tax,
    notes: i.notes,
    station: i.station,
    status: i.status,
    sentAt: i.sentAt,
    readyAt: i.readyAt,
    voidReason: i.voidReason,
    /** Importe de lo pendiente de cobrar de este producto (con su impuesto). */
    pendingTotal: remaining > 0n ? m(calculateLine(lineInput(i, remaining)).total) : "0.00",
  };
};

export const orderDto = (o: OrderFull) => ({
  id: o.id,
  number: o.number,
  status: o.status,
  branchId: o.branchId,
  covers: o.covers,
  notes: o.notes,
  openedAt: o.openedAt,
  closedAt: o.closedAt,
  cancelReason: o.cancelReason,
  table: { id: o.table.id, name: o.table.name, zone: o.table.zone },
  items: o.items.map(itemDto),
  totals: orderTotals(o.items),
});
