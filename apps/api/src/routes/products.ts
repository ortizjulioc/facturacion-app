import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { zv } from "../lib/validator";
import { z } from "zod";
import { fromCents, fromMilli, TAX_CODES, toCents, toMilli } from "@facturacion/core";
import type { Prisma } from "@facturacion/db";
import { auditEntry } from "../lib/audit";
import {
  listQuery,
  money,
  optionalText,
  pageOf,
  quantity,
  uuidParam,
} from "../lib/schemas";
import { requireRole } from "../middleware/tenant";
import type { AppEnv, TenantTx } from "../types";

type ProductRow = Prisma.ProductGetPayload<object>;

/** Los montos viajan como texto decimal ("19.99"): JSON no soporta BigInt. */
export const productDto = (p: ProductRow, showCost = false) => ({
  id: p.id,
  name: p.name,
  description: p.description,
  sku: p.sku,
  barcode: p.barcode,
  categoryId: p.categoryId,
  price: fromCents(p.price),
  priceIncludesTax: p.priceIncludesTax,
  tax: p.tax,
  unit: p.unit,
  allowsDecimals: p.allowsDecimals,
  trackInventory: p.trackInventory,
  minStock: fromMilli(p.minStock),
  active: p.active,
  createdAt: p.createdAt,
  updatedAt: p.updatedAt,
  // El costo de compra solo lo ven propietarios y administradores (el cajero no).
  ...(showCost ? { lastCost: p.lastCost === null ? null : fromCents(p.lastCost) } : {}),
});

const seesCost = (c: Context<AppEnv>) =>
  c
    .get("role")
    .split(",")
    .some((r) => ["owner", "admin"].includes(r.trim()));

const fields = {
  name: z.string().trim().min(1).max(200),
  description: optionalText(1000),
  sku: optionalText(64),
  barcode: z
    .string()
    .trim()
    .max(64)
    .regex(/^[A-Za-z0-9-]*$/, "El código de barras solo admite letras, números y guiones")
    .nullish()
    .transform((v) => (v ? v : null)),
  categoryId: z.uuid().nullish(),
  price: money,
  priceIncludesTax: z.boolean(),
  tax: z.enum(TAX_CODES),
  unit: z.string().trim().min(1).max(10),
  allowsDecimals: z.boolean(),
  trackInventory: z.boolean(),
  minStock: quantity,
};

// Los valores por defecto se aplican al crear, NO en el esquema: así un PATCH parcial no los pisa.
const createProduct = z.object({
  name: fields.name,
  price: fields.price,
  description: fields.description,
  sku: fields.sku,
  barcode: fields.barcode,
  categoryId: fields.categoryId,
  priceIncludesTax: fields.priceIncludesTax.default(true),
  tax: fields.tax.default("ITBIS18"),
  unit: fields.unit.default("UND"),
  allowsDecimals: fields.allowsDecimals.default(false),
  trackInventory: fields.trackInventory.default(false),
  minStock: fields.minStock.default("0"),
});

const updateProduct = z
  .object({
    name: fields.name,
    description: fields.description,
    sku: fields.sku,
    barcode: fields.barcode,
    categoryId: fields.categoryId,
    price: fields.price,
    priceIncludesTax: fields.priceIncludesTax,
    tax: fields.tax,
    unit: fields.unit,
    allowsDecimals: fields.allowsDecimals,
    trackInventory: fields.trackInventory,
    minStock: fields.minStock,
    active: z.boolean(),
  })
  .partial();

const productsQuery = listQuery.extend({ categoryId: z.uuid().optional() });

const canWrite = requireRole("owner", "admin");

async function assertCategory(tx: TenantTx, categoryId: string | null | undefined) {
  if (!categoryId) return;
  // RLS oculta las categorías de otras empresas, así que no se pueden referenciar.
  const found = await tx.category.findFirst({ where: { id: categoryId } });
  if (!found) throw new HTTPException(422, { message: "La categoría no existe" });
}

export const products = new Hono<AppEnv>()
  .get("/", zv("query", productsQuery), async (c) => {
    const { q, page, pageSize, active, categoryId } = c.req.valid("query");
    const where: Prisma.ProductWhereInput = {
      ...(active === undefined ? {} : { active }),
      ...(categoryId ? { categoryId } : {}),
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: "insensitive" } },
              { sku: { contains: q, mode: "insensitive" } },
              { barcode: { contains: q } },
            ],
          }
        : {}),
    };
    const db = c.get("db");
    const [rows, total] = await Promise.all([
      db.product.findMany({
        where,
        orderBy: { name: "asc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      db.product.count({ where }),
    ]);
    return c.json(
      pageOf(
        rows.map((r) => productDto(r, seesCost(c))),
        total,
        page,
        pageSize,
      ),
    );
  })
  // Búsqueda exacta por código de barras: la usa la caja al escanear.
  .get("/by-barcode/:code", async (c) => {
    const product = await c
      .get("db")
      .product.findFirst({ where: { barcode: c.req.param("code"), active: true } });
    if (!product) throw new HTTPException(404, { message: "Producto no encontrado" });
    return c.json({ data: productDto(product, seesCost(c)) });
  })
  .get("/:id", zv("param", uuidParam), async (c) => {
    const product = await c
      .get("db")
      .product.findFirst({ where: { id: c.req.valid("param").id } });
    if (!product) throw new HTTPException(404, { message: "Producto no encontrado" });
    return c.json({ data: productDto(product, seesCost(c)) });
  })
  .post("/", canWrite, zv("json", createProduct), async (c) => {
    const { price, minStock, ...input } = c.req.valid("json");
    const product = await c.get("run")(async (tx) => {
      await assertCategory(tx, input.categoryId);
      const created = await tx.product.create({
        data: {
          ...input,
          price: toCents(price),
          minStock: toMilli(minStock),
          organizationId: c.get("organizationId"),
        },
      });
      await tx.auditLog.create({
        data: auditEntry(c, "product.create", "product", created.id, {
          name: created.name,
          price,
        }),
      });
      return created;
    });
    return c.json({ data: productDto(product, seesCost(c)) }, 201);
  })
  .patch(
    "/:id",
    canWrite,
    zv("param", uuidParam),
    zv("json", updateProduct),
    async (c) => {
      const { id } = c.req.valid("param");
      const { price, minStock, ...input } = c.req.valid("json");
      const product = await c.get("run")(async (tx) => {
        await assertCategory(tx, input.categoryId);
        const updated = await tx.product.update({
          where: { id },
          data: {
            ...input,
            ...(price === undefined ? {} : { price: toCents(price) }),
            ...(minStock === undefined ? {} : { minStock: toMilli(minStock) }),
          },
        });
        await tx.auditLog.create({
          data: auditEntry(c, "product.update", "product", id, {
            fields: Object.keys(c.req.valid("json")),
          }),
        });
        return updated;
      });
      return c.json({ data: productDto(product, seesCost(c)) });
    },
  )
  // Un producto facturado no puede desaparecer: DELETE lo desactiva.
  .delete("/:id", canWrite, zv("param", uuidParam), async (c) => {
    const { id } = c.req.valid("param");
    await c.get("run")(async (tx) => {
      await tx.product.update({ where: { id }, data: { active: false } });
      await tx.auditLog.create({
        data: auditEntry(c, "product.deactivate", "product", id),
      });
    });
    return c.body(null, 204);
  });
