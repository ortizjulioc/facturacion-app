import { HTTPException } from "hono/http-exception";
import { fromMilli } from "@facturacion/core";
import type { Prisma } from "@facturacion/db";
import type { TenantTx } from "../types";

type MoveInput = {
  organizationId: string;
  userId: string;
  productId: string;
  productName: string;
  branchId: string;
  /** Con signo, en milésimas. */
  delta: bigint;
  type: "RECEIPT" | "SALE" | "RETURN" | "ADJUSTMENT";
  /** false: se rechaza el movimiento si dejaría la existencia por debajo de cero. */
  allowNegative: boolean;
  unitCost?: bigint | null;
  documentId?: string | null;
  purchaseId?: string | null;
  reason?: string | null;
};

/**
 * Cambia la existencia de un producto en una sucursal y deja el movimiento en el libro.
 *
 * La existencia se actualiza con un único `UPDATE … SET quantity = quantity + δ` (con condición
 * cuando no se permite negativo), así que dos cajas vendiendo a la vez nunca pisan el saldo ni
 * venden la misma última unidad. Todo ocurre en la transacción del llamador: si algo falla después,
 * el saldo y el movimiento se revierten juntos.
 *
 * Devuelve la existencia resultante.
 */
export async function moveStock(tx: TenantTx, m: MoveInput): Promise<bigint> {
  await tx.$executeRaw`
    INSERT INTO "stock_level" ("id", "organizationId", "productId", "branchId", "quantity", "updatedAt")
    VALUES (gen_random_uuid(), ${m.organizationId}, ${m.productId}::uuid, ${m.branchId}::uuid, 0, now())
    ON CONFLICT ("productId", "branchId") DO NOTHING`;

  const rows = await tx.$queryRaw<{ quantity: bigint }[]>`
    UPDATE "stock_level"
    SET "quantity" = "quantity" + ${m.delta}::bigint, "updatedAt" = now()
    WHERE "productId" = ${m.productId}::uuid AND "branchId" = ${m.branchId}::uuid
      AND (${m.allowNegative}::boolean OR "quantity" + ${m.delta}::bigint >= 0)
    RETURNING "quantity"`;

  const row = rows[0];
  if (!row) {
    const current = await tx.stockLevel.findFirst({
      where: { productId: m.productId, branchId: m.branchId },
      select: { quantity: true },
    });
    throw new HTTPException(422, {
      message: `Sin existencia suficiente de "${m.productName}" (disponible: ${fromMilli(current?.quantity ?? 0n)})`,
    });
  }

  const balanceAfter = BigInt(row.quantity);
  await tx.stockMovement.create({
    data: {
      organizationId: m.organizationId,
      productId: m.productId,
      branchId: m.branchId,
      type: m.type,
      quantity: m.delta,
      balanceAfter,
      unitCost: m.unitCost ?? null,
      documentId: m.documentId ?? null,
      purchaseId: m.purchaseId ?? null,
      reason: m.reason ?? null,
      createdById: m.userId,
    },
  });
  return balanceAfter;
}

type DocForStock = Prisma.DocumentGetPayload<{ include: { lines: true } }>;

/**
 * Efecto de EMITIR un comprobante sobre el inventario (solo productos con `trackInventory`):
 *  - E31 / E32: salida por venta.
 *  - E34 con código 1 (anula el comprobante): reingreso de lo vendido en el original.
 *  - Otras notas: no mueven inventario (corrigen montos o textos; para devoluciones parciales
 *    se registra un ajuste a mano).
 *
 * Los productos se procesan en orden estable para evitar bloqueos cruzados entre emisiones concurrentes.
 */
export async function applyDocumentStock(
  tx: TenantTx,
  doc: DocForStock,
  userId: string,
  allowNegative: boolean,
): Promise<void> {
  let source: {
    lines: DocForStock["lines"];
    branchId: string;
    type: "SALE" | "RETURN";
    reason: string | null;
  } | null = null;

  if (doc.type === "E31" || doc.type === "E32") {
    source = { lines: doc.lines, branchId: doc.branchId, type: "SALE", reason: null };
  } else if (
    doc.type === "E34" &&
    doc.modificationCode === 1 &&
    doc.referencedDocumentId
  ) {
    const original = await tx.document.findFirst({
      where: { id: doc.referencedDocumentId },
      include: { lines: true },
    });
    if (original) {
      source = {
        lines: original.lines,
        branchId: original.branchId,
        type: "RETURN",
        reason: `Anulación de ${original.encf ?? "comprobante"}`,
      };
    }
  }
  if (!source) return;

  const totals = new Map<string, bigint>();
  for (const line of source.lines) {
    if (line.productId)
      totals.set(line.productId, (totals.get(line.productId) ?? 0n) + line.quantity);
  }
  if (totals.size === 0) return;

  const products = await tx.product.findMany({
    where: { id: { in: [...totals.keys()] }, trackInventory: true },
    select: { id: true, name: true },
  });

  for (const product of products.sort((a, b) => a.id.localeCompare(b.id))) {
    const qty = totals.get(product.id)!;
    await moveStock(tx, {
      organizationId: doc.organizationId,
      userId,
      productId: product.id,
      productName: product.name,
      branchId: source.branchId,
      delta: source.type === "SALE" ? -qty : qty,
      type: source.type,
      allowNegative: source.type === "RETURN" ? true : allowNegative,
      documentId: doc.id,
      reason: source.reason,
    });
  }
}
