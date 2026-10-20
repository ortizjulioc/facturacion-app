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

/**
 * Lo que aún falta por cobrar de un producto (0 si está anulado o ya se cobró completo).
 * Las partes de un combo no se cobran por separado: el combo se cobra en su producto «padre».
 */
export const remainingOf = (
  item: Pick<Item, "status" | "quantity" | "billedQuantity"> & { parentItemId?: string | null },
) => (item.status === "VOID" || item.parentItemId ? 0n : item.quantity - item.billedQuantity);

export type StoredModifier = { id: string; name: string; price: string };

/** Los modificadores se guardan como JSON; esto lo lee de forma segura. */
export const modifiersOf = (item: Pick<Item, "modifiers">): StoredModifier[] =>
  Array.isArray(item.modifiers)
    ? (item.modifiers as unknown[]).flatMap((m) => {
        const x = m as Partial<StoredModifier> | null;
        return x && typeof x.id === "string" && typeof x.name === "string" && typeof x.price === "string"
          ? [{ id: x.id, name: x.name, price: x.price }]
          : [];
      })
    : [];

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
export function orderTotals(
  items: (Pick<Item, "status" | "quantity" | "billedQuantity" | "unitPrice" | "tax" | "priceIncludesTax"> & {
    parentItemId?: string | null;
  })[],
) {
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
    course: i.course,
    modifiers: modifiersOf(i).map((m) => ({ id: m.id, name: m.name, price: fromCents(BigInt(m.price)) })),
    /** Si es parte de un combo: el id del combo (el padre se cobra; las partes solo van a cocina). */
    parentItemId: i.parentItemId,
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
