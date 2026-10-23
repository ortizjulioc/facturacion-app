import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { fromCents, isIsrWithholdingType, toCents } from "@facturacion/core";
import type { Prisma } from "@facturacion/db";
import { auditEntry } from "../lib/audit";
import {
  buildPurchaseDraft,
  postPurchase,
  FULL,
  PURCHASE_KINDS,
  purchaseDto,
  purchaseInput,
  purchaseSummaryDto,
} from "../lib/purchases";
import { isoDate, listQuery, money, pageOf, uuidParam } from "../lib/schemas";
import { zv } from "../lib/validator";
import { requireRole } from "../middleware/tenant";
import type { AppEnv } from "../types";

const purchasesQuery = listQuery.omit({ active: true }).extend({
  kind: z.enum(PURCHASE_KINDS).optional(),
  status: z.enum(["DRAFT", "POSTED"]).optional(),
  supplierId: z.uuid().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

const notFound = () => new HTTPException(404, { message: "Compra no encontrada" });

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
  // Datos del 606 que no cambian la contabilidad —fecha de pago y tipo de retención en ISR—: se completan aun con la compra
  // registrada (p. ej. cuando por fin se paga una compra a crédito).
  .patch(
    "/:id/dgii",
    zv("param", uuidParam),
    zv("json", z.object({ paymentDate: isoDate.nullable().optional(), isrWithholdingType: z.number().int().min(1).max(9).nullable().optional(), itbisToCost: money.optional(), itbisProportional: money.optional() })),
    async (c) => {
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");
      const purchase = await c.get("run")(async (tx) => {
        const current = await tx.purchase.findFirst({ where: { id } });
        if (!current) throw notFound();
        const paymentDate = input.paymentDate === undefined ? current.paymentDate : input.paymentDate ? new Date(`${input.paymentDate}T00:00:00Z`) : null;
        if (paymentDate && paymentDate < current.invoiceDate) {
          throw new HTTPException(422, { message: "La fecha de pago no puede ser anterior a la del comprobante" });
        }
        const type = input.isrWithholdingType === undefined ? current.isrWithholdingType : input.isrWithholdingType;
        if (type !== null && !isIsrWithholdingType(type)) throw new HTTPException(422, { message: "Tipo de retención en ISR inválido" });
        if (type !== null && current.isrWithheld === 0n) {
          throw new HTTPException(422, { message: "La compra no tiene ISR retenido" });
        }
        const itbisToCost = input.itbisToCost === undefined ? current.itbisToCost : toCents(input.itbisToCost);
        const itbisProportional = input.itbisProportional === undefined ? current.itbisProportional : toCents(input.itbisProportional);
        if (itbisToCost + itbisProportional > current.totalTax) {
          throw new HTTPException(422, { message: "El ITBIS llevado al costo y el sujeto a proporcionalidad no pueden sumar más que el ITBIS de la compra" });
        }
        const updated = await tx.purchase.update({ where: { id }, data: { paymentDate, isrWithholdingType: type, itbisToCost, itbisProportional }, include: FULL });
        await tx.auditLog.create({ data: auditEntry(c, "purchase.dgii", "purchase", id, { paymentDate: input.paymentDate ?? null, isrWithholdingType: type, itbisToCost: itbisToCost.toString(), itbisProportional: itbisProportional.toString() }) });
        return updated;
      });
      return c.json({ data: purchaseDto(purchase) });
    },
  )
  // Registra la compra: asigna el e-NCF (E41/E43), da entrada al inventario y la congela.
  .post("/:id/post", zv("param", uuidParam), async (c) => {
    const { id } = c.req.valid("param");
    const purchase = await c.get("run")((tx) => postPurchase(tx, c.get("organizationId"), id, c.get("user").id));
    return c.json({ data: purchaseDto(purchase) });
  });
