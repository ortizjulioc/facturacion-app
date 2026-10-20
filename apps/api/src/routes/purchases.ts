import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { convertCents, fromCents, unitCostFromBase } from "@facturacion/core";
import type { Prisma } from "@facturacion/db";
import { auditEntry } from "../lib/audit";
import { allocateEncf } from "../lib/encf";
import {
  buildPurchaseDraft,
  FULL,
  PURCHASE_KINDS,
  purchaseDto,
  purchaseInput,
  purchaseSummaryDto,
  type PurchaseFull,
} from "../lib/purchases";
import { isoDate, listQuery, pageOf, uuidParam } from "../lib/schemas";
import { moveStock } from "../lib/stock";
import { zv } from "../lib/validator";
import { requireRole } from "../middleware/tenant";
import type { AppEnv, TenantTx } from "../types";

const purchasesQuery = listQuery.omit({ active: true }).extend({
  kind: z.enum(PURCHASE_KINDS).optional(),
  status: z.enum(["DRAFT", "POSTED"]).optional(),
  supplierId: z.uuid().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

const notFound = () => new HTTPException(404, { message: "Compra no encontrada" });
const unprocessable = (message: string) => new HTTPException(422, { message });

/**
 * Entrada al inventario por una compra registrada (salvo gastos menores).
 * El costo guardado es el unitario NETO (sin impuesto) y en pesos; también actualiza el "último costo"
 * del producto, aunque no controle inventario.
 */
async function applyPurchaseStock(tx: TenantTx, purchase: PurchaseFull, userId: string) {
  const perProduct = new Map<string, { qty: bigint; base: bigint }>();
  for (const line of purchase.lines) {
    if (!line.productId) continue;
    const acc = perProduct.get(line.productId) ?? { qty: 0n, base: 0n };
    acc.qty += line.quantity;
    acc.base += convertCents(line.base, purchase.exchangeRate.toString());
    perProduct.set(line.productId, acc);
  }
  if (perProduct.size === 0) return;

  const products = await tx.product.findMany({
    where: { id: { in: [...perProduct.keys()] } },
    select: { id: true, name: true, trackInventory: true },
  });
  // Orden estable: evita bloqueos cruzados entre registros concurrentes.
  for (const product of products.sort((a, b) => a.id.localeCompare(b.id))) {
    const { qty, base } = perProduct.get(product.id)!;
    const unitCost = unitCostFromBase(base, qty);
    if (product.trackInventory) {
      await moveStock(tx, {
        organizationId: purchase.organizationId,
        userId,
        productId: product.id,
        productName: product.name,
        branchId: purchase.branchId,
        delta: qty,
        type: "RECEIPT",
        allowNegative: true,
        unitCost,
        purchaseId: purchase.id,
        reason: `Compra ${purchase.ncf ?? ""}`.trim(),
      });
    }
    await tx.product.update({ where: { id: product.id }, data: { lastCost: unitCost } });
  }
}

// Las compras, los costos y los proveedores son del propietario y los administradores.
export const purchases = new Hono<AppEnv>()
  .use("*", requireRole("owner", "admin"))
  .get("/", zv("query", purchasesQuery), async (c) => {
    const { q, page, pageSize, kind, status, supplierId, from, to } =
      c.req.valid("query");
    const where: Prisma.PurchaseWhereInput = {
      ...(kind ? { kind } : {}),
      ...(status ? { status } : {}),
      ...(supplierId ? { supplierId } : {}),
      ...(from || to
        ? {
            invoiceDate: {
              ...(from ? { gte: new Date(`${from}T00:00:00Z`) } : {}),
              ...(to ? { lte: new Date(`${to}T00:00:00Z`) } : {}),
            },
          }
        : {}),
      ...(q
        ? {
            OR: [
              { ncf: { contains: q.toUpperCase().replace(/[\s-]/g, "") } },
              { supplierName: { contains: q, mode: "insensitive" } },
              { supplierDocNumber: { contains: q.replace(/[\s-]/g, "") } },
            ],
          }
        : {}),
    };
    const db = c.get("db");
    const [rows, total] = await Promise.all([
      db.purchase.findMany({
        where,
        orderBy: [{ invoiceDate: "desc" }, { createdAt: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      db.purchase.count({ where }),
    ]);
    return c.json(pageOf(rows.map(purchaseSummaryDto), total, page, pageSize));
  })
  .get("/:id", zv("param", uuidParam), async (c) => {
    const purchase = await c.get("db").purchase.findFirst({
      where: { id: c.req.valid("param").id },
      include: FULL,
    });
    if (!purchase) throw notFound();
    return c.json({ data: purchaseDto(purchase) });
  })
  .post("/", zv("json", purchaseInput), async (c) => {
    const input = c.req.valid("json");
    const organizationId = c.get("organizationId");
    const purchase = await c.get("run")(async (tx) => {
      const { purchase: header, lines } = await buildPurchaseDraft(tx, input);
      const created = await tx.purchase.create({
        data: {
          ...header,
          organizationId,
          createdById: c.get("user").id,
          lines: { create: lines.map((l) => ({ ...l, organizationId })) },
        },
        include: FULL,
      });
      await tx.auditLog.create({
        data: auditEntry(c, "purchase.create", "purchase", created.id, {
          kind: created.kind,
          total: fromCents(created.total),
        }),
      });
      return created;
    });
    return c.json({ data: purchaseDto(purchase) }, 201);
  })
  // Reemplaza el contenido de un borrador.
  .put("/:id", zv("param", uuidParam), zv("json", purchaseInput), async (c) => {
    const { id } = c.req.valid("param");
    const input = c.req.valid("json");
    const organizationId = c.get("organizationId");
    const purchase = await c.get("run")(async (tx) => {
      const current = await tx.purchase.findFirst({ where: { id } });
      if (!current) throw notFound();
      if (current.status !== "DRAFT") {
        throw new HTTPException(409, {
          message: "Una compra registrada no se puede modificar",
        });
      }
      const { purchase: header, lines } = await buildPurchaseDraft(tx, input, id);
      await tx.purchaseLine.deleteMany({ where: { purchaseId: id } });
      const updated = await tx.purchase.update({
        where: { id },
        data: {
          ...header,
          lines: { create: lines.map((l) => ({ ...l, organizationId })) },
        },
        include: FULL,
      });
      await tx.auditLog.create({
        data: auditEntry(c, "purchase.update", "purchase", id),
      });
      return updated;
    });
    return c.json({ data: purchaseDto(purchase) });
  })
  .delete("/:id", zv("param", uuidParam), async (c) => {
    const { id } = c.req.valid("param");
    await c.get("run")(async (tx) => {
      const current = await tx.purchase.findFirst({ where: { id } });
      if (!current) throw notFound();
      if (current.status !== "DRAFT") {
        throw new HTTPException(409, {
          message: "Una compra registrada no se puede eliminar",
        });
      }
      await tx.purchase.delete({ where: { id } });
      await tx.auditLog.create({
        data: auditEntry(c, "purchase.delete", "purchase", id),
      });
    });
    return c.body(null, 204);
  })
  // Registra la compra: asigna el e-NCF (E41/E43), da entrada al inventario y la congela.
  .post("/:id/post", zv("param", uuidParam), async (c) => {
    const { id } = c.req.valid("param");
    const purchase = await c.get("run")(async (tx) => {
      const draft = await tx.purchase.findFirst({ where: { id }, include: FULL });
      if (!draft) throw notFound();
      if (draft.status !== "DRAFT")
        throw new HTTPException(409, { message: "Esta compra ya está registrada" });
      if (draft.total <= 0n)
        throw unprocessable("El total de la compra debe ser mayor que cero");

      // El proveedor se refresca desde su ficha: pudo cambiar desde que se creó el borrador.
      let supplier = {
        supplierName: draft.supplierName,
        supplierDocType: draft.supplierDocType,
        supplierDocNumber: draft.supplierDocNumber,
      };
      if (draft.supplierId) {
        const s = await tx.supplier.findFirst({ where: { id: draft.supplierId } });
        if (s) {
          supplier = {
            supplierName: s.name,
            supplierDocType: s.documentType,
            supplierDocNumber: s.documentNumber,
          };
        }
      }

      let ncf = draft.ncf;
      if (draft.kind !== "SUPPLIER_INVOICE") {
        if (draft.kind === "E41" && !supplier.supplierDocNumber) {
          throw unprocessable(
            "El comprobante de compras exige que el proveedor tenga cédula o RNC",
          );
        }
        const profile = await tx.companyProfile.findFirst();
        if (!profile) {
          throw unprocessable(
            "Registra los datos fiscales de la empresa antes de emitir comprobantes",
          );
        }
        ncf = await allocateEncf(tx, draft.kind, null);
      }

      const posted = await tx.purchase.update({
        where: { id },
        data: { status: "POSTED", postedAt: new Date(), ncf, ...supplier },
        include: FULL,
      });
      if (draft.kind !== "E43") await applyPurchaseStock(tx, posted, c.get("user").id);
      await tx.auditLog.create({
        data: auditEntry(c, "purchase.post", "purchase", id, {
          kind: posted.kind,
          ncf,
          total: fromCents(posted.total),
        }),
      });
      return posted;
    });
    return c.json({ data: purchaseDto(purchase) });
  });
