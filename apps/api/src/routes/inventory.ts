import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { fromCents, fromMilli, toCents, toMilli, toSignedMilli } from "@facturacion/core";
import { Prisma } from "@facturacion/db";
import { auditEntry } from "../lib/audit";
import { listQuery, money, optionalText, pageOf, quantity } from "../lib/schemas";
import { moveStock } from "../lib/stock";
import { zv } from "../lib/validator";
import { requireRole } from "../middleware/tenant";
import type { AppEnv, TenantTx } from "../types";

const canWrite = requireRole("owner", "admin");
const unprocessable = (message: string) => new HTTPException(422, { message });

/** Escapa % _ \ para usar texto del usuario dentro de un ILIKE. */
const like = (text: string) => `%${text.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

const stockQuery = listQuery.omit({ active: true }).extend({
  branchId: z.uuid().optional(),
  /** true: solo agotados o por debajo del mínimo. */
  low: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
});

const movementsQuery = listQuery.omit({ active: true, q: true }).extend({
  productId: z.uuid().optional(),
  branchId: z.uuid().optional(),
  type: z.enum(["RECEIPT", "SALE", "RETURN", "ADJUSTMENT"]).optional(),
});

const receiptBody = z.object({
  productId: z.uuid(),
  branchId: z.uuid(),
  quantity,
  /** Costo unitario en pesos (opcional). */
  unitCost: money.optional(),
  reason: optionalText(250),
});

const signedQuantity = z
  .string()
  .trim()
  .regex(/^-?\d{1,9}(\.\d{1,3})?$/, "Cantidad inválida, máximo 3 decimales");

const adjustmentBody = z.object({
  productId: z.uuid(),
  branchId: z.uuid(),
  /** "delta": suma o resta la cantidad indicada. "count": fija la existencia a lo contado. */
  mode: z.enum(["delta", "count"]),
  quantity: signedQuantity,
  reason: z.string().trim().min(3, "Indica el motivo del ajuste").max(250),
});

/** Producto con inventario y sucursal activa: base de toda operación manual. */
async function loadTarget(tx: TenantTx, productId: string, branchId: string) {
  const product = await tx.product.findFirst({ where: { id: productId } });
  if (!product) throw unprocessable("El producto no existe");
  if (!product.trackInventory) {
    throw unprocessable(
      `"${product.name}" no controla inventario: actívalo en la ficha del producto`,
    );
  }
  const branch = await tx.branch.findFirst({ where: { id: branchId, active: true } });
  if (!branch) throw unprocessable("La sucursal no existe o está inactiva");
  return { product, branch };
}

type StockRow = {
  id: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  unit: string;
  allowsDecimals: boolean;
  minStock: bigint;
  quantity: bigint;
};

export const inventory = new Hono<AppEnv>()
  // Existencias de los productos con inventario (de una sucursal, o sumadas de todas).
  .get("/stock", zv("query", stockQuery), async (c) => {
    const { q, page, pageSize, branchId, low } = c.req.valid("query");
    const onBranch = branchId
      ? Prisma.sql`AND sl."branchId" = ${branchId}::uuid`
      : Prisma.empty;
    const search = q
      ? Prisma.sql`AND (p."name" ILIKE ${like(q)} OR p."sku" ILIKE ${like(q)} OR p."barcode" ILIKE ${like(q)})`
      : Prisma.empty;
    const onlyLow = low ? Prisma.sql`WHERE s."quantity" <= s."minStock"` : Prisma.empty;

    const base = Prisma.sql`
      SELECT p."id", p."name", p."sku", p."barcode", p."unit", p."allowsDecimals", p."minStock",
             COALESCE(SUM(sl."quantity"), 0)::bigint AS quantity
      FROM "product" p
      LEFT JOIN "stock_level" sl ON sl."productId" = p."id" ${onBranch}
      WHERE p."trackInventory" AND p."active" ${search}
      GROUP BY p."id"`;

    const { rows, total } = await c.get("run")(async (tx) => {
      const rows = await tx.$queryRaw<StockRow[]>(Prisma.sql`
        SELECT * FROM (${base}) s ${onlyLow}
        ORDER BY s."name" ASC
        LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`);
      const count = await tx.$queryRaw<{ n: number }[]>(
        Prisma.sql`SELECT COUNT(*)::int AS n FROM (${base}) s ${onlyLow}`,
      );
      return { rows, total: count[0]?.n ?? 0 };
    });

    const data = rows.map((r) => ({
      productId: r.id,
      name: r.name,
      sku: r.sku,
      barcode: r.barcode,
      unit: r.unit,
      allowsDecimals: r.allowsDecimals,
      quantity: fromMilli(r.quantity),
      minStock: fromMilli(r.minStock),
      status: r.quantity <= 0n ? "OUT" : r.quantity <= r.minStock ? "LOW" : "OK",
    }));
    return c.json(pageOf(data, total, page, pageSize));
  })
  // Libro de movimientos (más recientes primero).
  .get("/movements", zv("query", movementsQuery), async (c) => {
    const { page, pageSize, productId, branchId, type } = c.req.valid("query");
    const where: Prisma.StockMovementWhereInput = {
      ...(productId ? { productId } : {}),
      ...(branchId ? { branchId } : {}),
      ...(type ? { type } : {}),
    };
    const db = c.get("db");
    const [rows, total] = await Promise.all([
      db.stockMovement.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          product: { select: { id: true, name: true, unit: true } },
          branch: { select: { id: true, name: true } },
          document: { select: { id: true, encf: true, type: true } },
        },
      }),
      db.stockMovement.count({ where }),
    ]);
    const data = rows.map((m) => ({
      id: m.id,
      type: m.type,
      quantity: fromMilli(m.quantity),
      balanceAfter: fromMilli(m.balanceAfter),
      unitCost: m.unitCost === null ? null : fromCents(m.unitCost),
      reason: m.reason,
      createdAt: m.createdAt,
      createdById: m.createdById,
      product: m.product,
      branch: m.branch,
      document: m.document,
    }));
    return c.json(pageOf(data, total, page, pageSize));
  })
  // Entrada de mercancía.
  .post("/receipts", canWrite, zv("json", receiptBody), async (c) => {
    const input = c.req.valid("json");
    const delta = toMilli(input.quantity);
    if (delta <= 0n) throw unprocessable("La cantidad debe ser mayor que cero");

    const result = await c.get("run")(async (tx) => {
      const { product } = await loadTarget(tx, input.productId, input.branchId);
      if (!product.allowsDecimals && delta % 1000n !== 0n) {
        throw unprocessable(`"${product.name}" no se maneja en fracciones`);
      }
      const balance = await moveStock(tx, {
        organizationId: c.get("organizationId"),
        userId: c.get("user").id,
        productId: product.id,
        productName: product.name,
        branchId: input.branchId,
        delta,
        type: "RECEIPT",
        allowNegative: true,
        unitCost: input.unitCost ? toCents(input.unitCost) : null,
        reason: input.reason ?? null,
      });
      await tx.auditLog.create({
        data: auditEntry(c, "inventory.receipt", "product", product.id, {
          branchId: input.branchId,
          quantity: input.quantity,
        }),
      });
      return balance;
    });
    return c.json({ data: { balance: fromMilli(result) } }, 201);
  })
  // Ajuste manual: por diferencia o fijando la existencia contada.
  .post("/adjustments", canWrite, zv("json", adjustmentBody), async (c) => {
    const input = c.req.valid("json");
    const result = await c.get("run")(async (tx) => {
      const { product } = await loadTarget(tx, input.productId, input.branchId);

      const typed = toSignedMilli(input.quantity);
      if (input.mode === "count" && typed < 0n) {
        throw unprocessable("La cantidad contada no puede ser negativa");
      }
      if (!product.allowsDecimals && typed % 1000n !== 0n) {
        throw unprocessable(`"${product.name}" no se maneja en fracciones`);
      }

      // En modo conteo la diferencia se calcula sobre el saldo bloqueado, no sobre el que vio la pantalla.
      let delta = typed;
      if (input.mode === "count") {
        await tx.$executeRaw`
          INSERT INTO "stock_level" ("id", "organizationId", "productId", "branchId", "quantity", "updatedAt")
          VALUES (gen_random_uuid(), ${c.get("organizationId")}, ${product.id}::uuid, ${input.branchId}::uuid, 0, now())
          ON CONFLICT ("productId", "branchId") DO NOTHING`;
        const locked = await tx.$queryRaw<{ quantity: bigint }[]>`
          SELECT "quantity" FROM "stock_level"
          WHERE "productId" = ${product.id}::uuid AND "branchId" = ${input.branchId}::uuid FOR UPDATE`;
        delta = typed - BigInt(locked[0]?.quantity ?? 0n);
      }
      if (delta === 0n)
        throw unprocessable("La existencia ya coincide: no hay nada que ajustar");

      const balance = await moveStock(tx, {
        organizationId: c.get("organizationId"),
        userId: c.get("user").id,
        productId: product.id,
        productName: product.name,
        branchId: input.branchId,
        delta,
        type: "ADJUSTMENT",
        allowNegative: true,
        reason: input.reason,
      });
      await tx.auditLog.create({
        data: auditEntry(c, "inventory.adjustment", "product", product.id, {
          branchId: input.branchId,
          delta: fromMilli(delta),
          reason: input.reason,
        }),
      });
      return { balance, delta };
    });
    return c.json(
      { data: { balance: fromMilli(result.balance), delta: fromMilli(result.delta) } },
      201,
    );
  })
  .get("/settings", async (c) => {
    const profile = await c
      .get("db")
      .companyProfile.findFirst({ select: { allowNegativeStock: true } });
    return c.json({
      data: {
        configured: Boolean(profile),
        allowNegativeStock: profile?.allowNegativeStock ?? true,
      },
    });
  })
  // ¿Se puede emitir un comprobante aunque falte existencia?
  .patch(
    "/settings",
    canWrite,
    zv("json", z.object({ allowNegativeStock: z.boolean() })),
    async (c) => {
      const { allowNegativeStock } = c.req.valid("json");
      const saved = await c.get("run")(async (tx) => {
        const profile = await tx.companyProfile.findFirst();
        if (!profile)
          throw unprocessable("Registra primero los datos fiscales de la empresa");
        const updated = await tx.companyProfile.update({
          where: { id: profile.id },
          data: { allowNegativeStock },
        });
        await tx.auditLog.create({
          data: auditEntry(c, "inventory.settings", "company_profile", profile.id, {
            allowNegativeStock,
          }),
        });
        return updated;
      });
      return c.json({ data: { allowNegativeStock: saved.allowNegativeStock } });
    },
  );
