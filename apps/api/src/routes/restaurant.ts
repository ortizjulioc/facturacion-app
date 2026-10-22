import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { DOCUMENT_TYPES, fromCents, fromMilli, toMilli } from "@facturacion/core";
import type { Prisma } from "@facturacion/db";
import { auditEntry } from "../lib/audit";
import {
  buildDraft,
  documentDto,
  FULL as DOCUMENT_FULL,
  paymentInput,
  type DocumentInput,
} from "../lib/documents";
import { issueDocument } from "../lib/issue";
import {
  itemDto,
  modifiersOf,
  ORDER_INCLUDE,
  orderDto,
  orderTotals,
  remainingOf,
  type OrderFull,
} from "../lib/orders";
import { applyComboStock } from "../lib/stock";
import { optionalText, quantity, uuidParam } from "../lib/schemas";
import { zv } from "../lib/validator";
import { requireRole } from "../middleware/tenant";
import type { AppEnv, TenantTx } from "../types";

const unprocessable = (message: string) => new HTTPException(422, { message });
const conflict = (message: string) => new HTTPException(409, { message });
const notFound = (what = "Comanda") => new HTTPException(404, { message: `${what} no encontrada` });

const isAdmin = (role: string) => role.split(",").some((r) => ["owner", "admin"].includes(r.trim()));
const adminOnly = requireRole("owner", "admin");

// ───────────── Esquemas ─────────────

const stationEnum = z.enum(["KITCHEN", "BAR"]);

const tableBody = z.object({
  branchId: z.uuid(),
  name: z.string().trim().min(1).max(40),
  zone: optionalText(40),
  seats: z.number().int().min(1).max(50).default(4),
});
const tableUpdate = z.object({
  name: z.string().trim().min(1).max(40).optional(),
  zone: optionalText(40).optional(),
  seats: z.number().int().min(1).max(50).optional(),
  active: z.boolean().optional(),
});
const bulkTables = z.object({
  branchId: z.uuid(),
  prefix: z.string().trim().min(1).max(30).default("Mesa"),
  count: z.number().int().min(1).max(100),
  startAt: z.number().int().min(1).max(999).default(1),
  zone: optionalText(40),
  seats: z.number().int().min(1).max(50).default(4),
});

const openBody = z.object({ tableId: z.uuid(), covers: z.number().int().min(1).max(200).nullish() });
const course = z.number().int().min(1).max(5);
const addItemBody = z.object({
  productId: z.uuid(),
  quantity: quantity.default("1"),
  notes: optionalText(200),
  /** Opciones elegidas (grupos de modificadores del producto). */
  modifierIds: z.array(z.uuid()).max(30).default([]),
  /** Curso en que sale; por defecto el del producto. */
  course: course.optional(),
});
const updateItemBody = z.object({
  quantity: quantity.optional(),
  notes: optionalText(200).optional(),
  course: course.optional(),
});
const sendBody = z.object({ course: course.optional() });
const voidBody = z.object({ reason: z.string().trim().max(200).optional() });
const itemParams = z.object({ id: z.uuid(), itemId: z.uuid() });

const billBody = z.object({
  /** Qué se cobra (para dividir la cuenta). Sin esto se cobra todo lo pendiente. */
  items: z.array(z.object({ itemId: z.uuid(), quantity })).min(1).max(200).optional(),
  type: z.enum(["E31", "E32"]).default("E32"),
  customerId: z.uuid().nullish(),
  buyer: z
    .object({
      name: z.string().trim().max(200).nullish(),
      docType: z.enum(DOCUMENT_TYPES).nullish(),
      docNumber: z.string().trim().max(30).nullish(),
    })
    .nullish(),
  terminalId: z.uuid().nullish(),
  /** Propina legal (10 %). En restaurantes es lo habitual, por eso va activada por defecto. */
  propinaLegal: z.boolean().default(true),
  payments: z.array(paymentInput).min(1, "Indica cómo se paga").max(20),
});

// ───────────── Ayudas ─────────────

async function loadOrder(tx: TenantTx, id: string): Promise<OrderFull> {
  const order = await tx.restaurantOrder.findFirst({ where: { id }, include: ORDER_INCLUDE });
  if (!order) throw notFound();
  return order;
}

/**
 * Carga una comanda ABIERTA bloqueando su fila hasta que termine la transacción: dos operaciones
 * simultáneas sobre la misma comanda (p. ej. dos cobros) se hacen una tras otra y la segunda ya ve
 * lo que cambió la primera.
 */
async function loadOpenOrder(tx: TenantTx, id: string): Promise<OrderFull> {
  await tx.$queryRaw`SELECT 1 FROM "restaurant_order" WHERE "id" = ${id}::uuid FOR UPDATE`;
  const order = await loadOrder(tx, id);
  if (order.status !== "OPEN") throw conflict("La comanda ya está cerrada o cancelada");
  return order;
}


export const restaurant = new Hono<AppEnv>()
  // ───────────── Mesas ─────────────
  // Salón: cada mesa con un resumen de su comanda abierta.
  .get("/tables", async (c) => {
    const branchId = c.req.query("branchId");
    const all = c.req.query("all") === "true" && isAdmin(c.get("role"));
    const tables = await c.get("db").diningTable.findMany({
      where: { ...(all ? {} : { active: true }), ...(branchId ? { branchId } : {}) },
      orderBy: [{ zone: "asc" }, { name: "asc" }],
      include: { orders: { where: { status: "OPEN" }, include: { items: true } } },
    });
    const data = tables.map((t) => {
      const open = t.orders[0];
      return {
        id: t.id,
        branchId: t.branchId,
        name: t.name,
        zone: t.zone,
        seats: t.seats,
        active: t.active,
        order: open
          ? {
              id: open.id,
              number: open.number,
              covers: open.covers,
              openedAt: open.openedAt,
              items: open.items.filter((i) => i.status !== "VOID" && !i.parentItemId).length,
              waiting: open.items.filter((i) => i.status === "SENT").length,
              // Listos y aún sin cobrar; las partes de un combo cuentan mientras su combo esté pendiente de cobro.
              ready: open.items.filter((i) => {
                if (i.status !== "READY") return false;
                const owner = i.parentItemId ? open.items.find((p) => p.id === i.parentItemId) : i;
                return !!owner && remainingOf(owner) > 0n;
              }).length,
              unsent: open.items.filter((i) => i.status === "PENDING").length,
              total: orderTotals(open.items).total,
            }
          : null,
      };
    });
    return c.json({ data });
  })
  .post("/tables", adminOnly, zv("json", tableBody), async (c) => {
    const input = c.req.valid("json");
    const table = await c.get("run")(async (tx) => {
      const branch = await tx.branch.findFirst({ where: { id: input.branchId, active: true } });
      if (!branch) throw unprocessable("La sucursal no existe o está inactiva");
      const created = await tx.diningTable.create({
        data: { ...input, organizationId: c.get("organizationId") },
      });
      await tx.auditLog.create({
        data: auditEntry(c, "table.create", "dining_table", created.id, { name: created.name }),
      });
      return created;
    });
    return c.json({ data: table }, 201);
  })
  // Crea "Mesa 1…Mesa N" de golpe; las que ya existen se omiten.
  .post("/tables/bulk", adminOnly, zv("json", bulkTables), async (c) => {
    const input = c.req.valid("json");
    const result = await c.get("run")(async (tx) => {
      const branch = await tx.branch.findFirst({ where: { id: input.branchId, active: true } });
      if (!branch) throw unprocessable("La sucursal no existe o está inactiva");
      const wanted = Array.from({ length: input.count }, (_, i) => `${input.prefix} ${input.startAt + i}`);
      const existing = await tx.diningTable.findMany({
        where: { branchId: input.branchId, name: { in: wanted } },
        select: { name: true },
      });
      const have = new Set(existing.map((e) => e.name));
      const toCreate = wanted.filter((n) => !have.has(n));
      if (toCreate.length > 0) {
        await tx.diningTable.createMany({
          data: toCreate.map((name) => ({
            organizationId: c.get("organizationId"),
            branchId: input.branchId,
            name,
            zone: input.zone ?? null,
            seats: input.seats,
          })),
        });
      }
      await tx.auditLog.create({
        data: auditEntry(c, "table.bulk", "dining_table", input.branchId, {
          created: toCreate.length,
          skipped: wanted.length - toCreate.length,
        }),
      });
      return { created: toCreate.length, skipped: wanted.length - toCreate.length };
    });
    return c.json({ data: result }, 201);
  })
  .patch("/tables/:id", adminOnly, zv("param", uuidParam), zv("json", tableUpdate), async (c) => {
    const { id } = c.req.valid("param");
    const input = c.req.valid("json");
    const table = await c.get("run")(async (tx) => {
      if (input.active === false) {
        const open = await tx.restaurantOrder.findFirst({ where: { tableId: id, status: "OPEN" } });
        if (open) throw conflict("La mesa tiene una comanda abierta");
      }
      const updated = await tx.diningTable.update({ where: { id }, data: input });
      await tx.auditLog.create({
        data: auditEntry(c, "table.update", "dining_table", id, { fields: Object.keys(input) }),
      });
      return updated;
    });
    return c.json({ data: table });
  })

  // ───────────── Comandas ─────────────
  .post("/orders", zv("json", openBody), async (c) => {
    const input = c.req.valid("json");
    const organizationId = c.get("organizationId");
    const order = await c.get("run")(async (tx) => {
      // El candado por empresa serializa la apertura de comandas: el consecutivo no se repite y
      // dos meseros no abren la misma mesa a la vez.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`order:${organizationId}`}))`;

      const table = await tx.diningTable.findFirst({ where: { id: input.tableId, active: true } });
      if (!table) throw unprocessable("La mesa no existe o está inactiva");
      const open = await tx.restaurantOrder.findFirst({ where: { tableId: table.id, status: "OPEN" } });
      if (open) throw conflict("La mesa ya tiene una comanda abierta");

      const last = await tx.restaurantOrder.aggregate({ _max: { number: true } });
      const created = await tx.restaurantOrder.create({
        data: {
          organizationId,
          branchId: table.branchId,
          tableId: table.id,
          number: (last._max.number ?? 0) + 1,
          covers: input.covers ?? null,
          openedById: c.get("user").id,
        },
        include: ORDER_INCLUDE,
      });
      await tx.auditLog.create({
        data: auditEntry(c, "order.open", "restaurant_order", created.id, {
          number: created.number,
          table: table.name,
        }),
      });
      return created;
    });
    return c.json({ data: orderDto(order) }, 201);
  })
  .get("/orders/:id", zv("param", uuidParam), async (c) => {
    const order = await c.get("db").restaurantOrder.findFirst({
      where: { id: c.req.valid("param").id },
      include: ORDER_INCLUDE,
    });
    if (!order) throw notFound();
    return c.json({ data: orderDto(order) });
  })
  .post("/orders/:id/items", zv("param", uuidParam), zv("json", addItemBody), async (c) => {
    const { id } = c.req.valid("param");
    const input = c.req.valid("json");
    const qty = toMilli(input.quantity);
    if (qty <= 0n) throw unprocessable("La cantidad debe ser mayor que cero");

    const order = await c.get("run")(async (tx) => {
      await loadOpenOrder(tx, id);
      const product = await tx.product.findFirst({
        where: { id: input.productId, active: true },
        include: {
          modifierGroups: { include: { group: { include: { modifiers: true } } } },
          comboComponents: { include: { product: true } },
        },
      });
      if (!product) throw unprocessable("El producto no existe o está inactivo");
      if (!product.allowsDecimals && qty % 1000n !== 0n) {
        throw unprocessable(`"${product.name}" no se vende en fracciones`);
      }
      const itemCourse = input.course ?? product.course;
      const base = {
        organizationId: c.get("organizationId"),
        orderId: id,
        unit: product.unit,
        priceIncludesTax: product.priceIncludesTax,
        tax: product.tax,
        notes: input.notes ?? null,
        course: itemCourse,
        createdById: c.get("user").id,
      };

      // Combo: una línea que se cobra (el combo) y una por cada componente, que solo va a cocina/bar.
      if (product.isCombo) {
        if (input.modifierIds.length > 0) throw unprocessable("Un combo no admite modificadores");
        const parts = product.comboComponents;
        if (parts.length === 0) throw unprocessable(`El combo "${product.name}" no tiene componentes`);
        const inactive = parts.find((k) => !k.product.active);
        if (inactive) throw unprocessable(`"${inactive.product.name}" ya no está disponible`);

        const parent = await tx.orderItem.create({
          data: { ...base, productId: product.id, name: product.name, quantity: qty, unitPrice: product.price, station: "NONE" },
        });
        for (const k of parts) {
          await tx.orderItem.create({
            data: {
              ...base,
              productId: k.productId,
              name: k.product.name,
              unit: k.product.unit,
              quantity: BigInt(k.quantity) * qty,
              unitPrice: 0n,
              priceIncludesTax: k.product.priceIncludesTax,
              tax: k.product.tax,
              station: k.product.prepStation,
              parentItemId: parent.id,
            },
          });
        }
        return loadOrder(tx, id);
      }

      // Modificadores: cada grupo del producto exige elegir entre su mínimo y su máximo.
      const chosen = new Set(input.modifierIds);
      if (chosen.size !== input.modifierIds.length) throw unprocessable("Una opción está repetida");
      const groups = product.modifierGroups.map((pg) => pg.group).filter((g) => g.active);
      const picked: { id: string; name: string; price: bigint }[] = [];
      for (const g of groups) {
        const options = g.modifiers.filter((m) => m.active && chosen.has(m.id));
        if (options.length < g.minSelect) {
          throw unprocessable(
            g.minSelect === 1 ? `Elige una opción de «${g.name}»` : `Elige al menos ${g.minSelect} opciones de «${g.name}»`,
          );
        }
        if (options.length > g.maxSelect) {
          throw unprocessable(`«${g.name}» admite como máximo ${g.maxSelect} opción${g.maxSelect === 1 ? "" : "es"}`);
        }
        picked.push(...options.map((m) => ({ id: m.id, name: m.name, price: m.price })));
      }
      if (picked.length !== chosen.size) throw unprocessable("Una de las opciones no corresponde a este producto");

      const stored = picked.map((m) => ({ id: m.id, name: m.name, price: String(m.price) }));
      const key = (ids: string[]) => [...ids].sort().join(",");

      // Si ya hay uno igual (mismas notas, curso y opciones) sin enviar, se suma en vez de duplicar la línea.
      const candidates = await tx.orderItem.findMany({
        where: { orderId: id, productId: product.id, status: "PENDING", notes: input.notes ?? null, course: itemCourse, parentItemId: null },
      });
      const same = candidates.find((i) => key(modifiersOf(i).map((m) => m.id)) === key(picked.map((m) => m.id)));
      if (same) {
        await tx.orderItem.update({ where: { id: same.id }, data: { quantity: { increment: qty } } });
      } else {
        await tx.orderItem.create({
          data: {
            ...base,
            productId: product.id,
            name: product.name,
            quantity: qty,
            unitPrice: product.price + picked.reduce((sum, m) => sum + m.price, 0n),
            station: product.prepStation,
            modifiers: stored,
          },
        });
      }
      return loadOrder(tx, id);
    });
    return c.json({ data: orderDto(order) }, 201);
  })
  // Cambiar cantidad o notas: solo mientras el producto no se ha enviado a cocina.
  .patch("/orders/:id/items/:itemId", zv("param", itemParams), zv("json", updateItemBody), async (c) => {
    const { id, itemId } = c.req.valid("param");
    const input = c.req.valid("json");
    const order = await c.get("run")(async (tx) => {
      await loadOpenOrder(tx, id);
      const item = await tx.orderItem.findFirst({ where: { id: itemId, orderId: id } });
      if (!item) throw notFound("Producto");
      if (item.parentItemId) throw conflict("Es parte de un combo: modifica el combo");
      if (item.status !== "PENDING") {
        throw conflict("Ese producto ya se envió a cocina: anúlalo y vuelve a agregarlo");
      }
      const data: Prisma.OrderItemUpdateInput = {};
      const parts = await tx.orderItem.findMany({ where: { parentItemId: itemId } });
      if (input.quantity !== undefined) {
        const qty = toMilli(input.quantity);
        if (qty <= 0n) throw unprocessable("La cantidad debe ser mayor que cero");
        const product = item.productId ? await tx.product.findFirst({ where: { id: item.productId } }) : null;
        if (product && !product.allowsDecimals && qty % 1000n !== 0n) {
          throw unprocessable(`"${product.name}" no se vende en fracciones`);
        }
        data.quantity = qty;
        // Las partes de un combo mantienen su proporción: cada una es (cantidad por combo) × combos.
        for (const part of parts) {
          await tx.orderItem.update({ where: { id: part.id }, data: { quantity: (part.quantity / item.quantity) * qty } });
        }
      }
      if ("notes" in input) {
        data.notes = input.notes ?? null;
        if (parts.length > 0) await tx.orderItem.updateMany({ where: { parentItemId: itemId }, data: { notes: input.notes ?? null } });
      }
      if (input.course !== undefined) {
        data.course = input.course;
        if (parts.length > 0) await tx.orderItem.updateMany({ where: { parentItemId: itemId }, data: { course: input.course } });
      }
      await tx.orderItem.update({ where: { id: itemId }, data });
      return loadOrder(tx, id);
    });
    return c.json({ data: orderDto(order) });
  })
  // Quitar un producto: sin enviar se borra; ya enviado se anula con motivo (queda registro).
  .post("/orders/:id/items/:itemId/void", zv("param", itemParams), zv("json", voidBody), async (c) => {
    const { id, itemId } = c.req.valid("param");
    const { reason } = c.req.valid("json");
    const order = await c.get("run")(async (tx) => {
      await loadOpenOrder(tx, id);
      const item = await tx.orderItem.findFirst({ where: { id: itemId, orderId: id } });
      if (!item) throw notFound("Producto");
      if (item.parentItemId) throw conflict("Es parte de un combo: anula el combo completo");
      if (item.status === "VOID") throw conflict("Ese producto ya está anulado");
      if (item.billedQuantity > 0n) throw conflict("Ese producto ya se cobró (total o parcialmente)");

      if (item.status === "PENDING") {
        // Las partes de un combo se borran en cascada junto con él.
        await tx.orderItem.delete({ where: { id: itemId } });
      } else {
        if (!reason || reason.length < 3) throw unprocessable("Indica el motivo de la anulación");
        await tx.orderItem.update({ where: { id: itemId }, data: { status: "VOID", voidReason: reason } });
        await tx.orderItem.updateMany({
          where: { parentItemId: itemId, status: { not: "VOID" } },
          data: { status: "VOID", voidReason: reason },
        });
        await tx.auditLog.create({
          data: auditEntry(c, "order.void_item", "order_item", itemId, { name: item.name, reason }),
        });
      }
      return loadOrder(tx, id);
    });
    return c.json({ data: orderDto(order) });
  })
  // Envía a cocina/bar lo que está pendiente. Lo que no pasa por preparación (estación NONE) queda listo.
  // Con `course` solo sale ese curso (entrada, plato fuerte…); sin él, todo lo pendiente.
  .post("/orders/:id/send", zv("param", uuidParam), zv("json", sendBody), async (c) => {
    const { id } = c.req.valid("param");
    const { course } = c.req.valid("json");
    const result = await c.get("run")(async (tx) => {
      await loadOpenOrder(tx, id);
      const pending = await tx.orderItem.findMany({
        where: { orderId: id, status: "PENDING", ...(course ? { course } : {}) },
        orderBy: { createdAt: "asc" },
      });
      if (pending.length === 0) {
        throw unprocessable(course ? `No hay productos pendientes en el curso ${course}` : "No hay productos por enviar");
      }
      const comboNames = new Map(pending.map((p) => [p.id, p.name]));

      const now = new Date();
      for (const item of pending) {
        const direct = item.station === "NONE";
        await tx.orderItem.update({
          where: { id: item.id },
          data: { status: direct ? "READY" : "SENT", sentAt: now, ...(direct ? { readyAt: now } : {}) },
        });
      }
      await tx.auditLog.create({
        data: auditEntry(c, "order.send", "restaurant_order", id, { items: pending.length }),
      });
      const order = await loadOrder(tx, id);
      return {
        order,
        sent: pending.map((p) => ({
          id: p.id,
          name: p.name,
          quantity: fromMilli(p.quantity),
          notes: p.notes,
          station: p.station,
          course: p.course,
          modifiers: modifiersOf(p).map((m) => m.name),
          combo: p.parentItemId ? (comboNames.get(p.parentItemId) ?? null) : null,
        })),
      };
    });
    return c.json({
      data: {
        order: orderDto(result.order),
        // Lo que se imprime/muestra como comanda, separado por estación.
        ticket: {
          number: result.order.number,
          table: result.order.table.name,
          zone: result.order.table.zone,
          covers: result.order.covers,
          /** Curso enviado (null = todo lo pendiente). */
          course: course ?? null,
          stations: (["KITCHEN", "BAR"] as const)
            .map((station) => ({ station, items: result.sent.filter((s) => s.station === station) }))
            .filter((s) => s.items.length > 0),
        },
      },
    });
  })
  .post("/orders/:id/transfer", zv("param", uuidParam), zv("json", z.object({ tableId: z.uuid() })), async (c) => {
    const { id } = c.req.valid("param");
    const { tableId } = c.req.valid("json");
    const order = await c.get("run")(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`order:${c.get("organizationId")}`}))`;
      const current = await loadOpenOrder(tx, id);
      const target = await tx.diningTable.findFirst({
        where: { id: tableId, active: true, branchId: current.branchId },
      });
      if (!target) throw unprocessable("La mesa no existe, está inactiva o es de otra sucursal");
      if (target.id === current.tableId) throw unprocessable("La comanda ya está en esa mesa");
      const open = await tx.restaurantOrder.findFirst({ where: { tableId: target.id, status: "OPEN" } });
      if (open) throw conflict("La mesa de destino ya tiene una comanda abierta");

      await tx.restaurantOrder.update({ where: { id }, data: { tableId: target.id } });
      await tx.auditLog.create({
        data: auditEntry(c, "order.transfer", "restaurant_order", id, {
          from: current.table.name,
          to: target.name,
        }),
      });
      return loadOrder(tx, id);
    });
    return c.json({ data: orderDto(order) });
  })
  // Cancelar una comanda sin cobro. Si ya hay productos en cocina solo un administrador puede.
  .post("/orders/:id/cancel", zv("param", uuidParam), zv("json", z.object({ reason: z.string().trim().min(3, "Indica el motivo").max(200) })), async (c) => {
    const { id } = c.req.valid("param");
    const { reason } = c.req.valid("json");
    await c.get("run")(async (tx) => {
      const order = await loadOpenOrder(tx, id);
      if (order.items.some((i) => i.billedQuantity > 0n)) {
        throw conflict("La comanda ya tiene cobros: no se puede cancelar");
      }
      if (order.items.some((i) => i.status === "SENT" || i.status === "READY") && !isAdmin(c.get("role"))) {
        throw new HTTPException(403, { message: "Solo un administrador puede cancelar una comanda con productos en preparación" });
      }
      await tx.restaurantOrder.update({
        where: { id },
        data: { status: "CANCELLED", closedAt: new Date(), cancelReason: reason },
      });
      await tx.auditLog.create({
        data: auditEntry(c, "order.cancel", "restaurant_order", id, { reason }),
      });
    });
    return c.body(null, 204);
  })

  // ───────────── Cobro (con división de cuenta y propina legal) ─────────────
  .post("/orders/:id/bill", zv("param", uuidParam), zv("json", billBody), async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const organizationId = c.get("organizationId");
    const userId = c.get("user").id;

    const result = await c.get("run")(async (tx) => {
      const order = await loadOpenOrder(tx, id);

      // Qué se cobra: lo indicado o todo lo pendiente.
      const byId = new Map(order.items.map((i) => [i.id, i]));
      const selection = body.items
        ? body.items.map((s) => {
            const item = byId.get(s.itemId);
            if (!item) throw unprocessable("Uno de los productos no pertenece a esta comanda");
            const qty = toMilli(s.quantity);
            if (qty <= 0n) throw unprocessable(`"${item.name}": la cantidad debe ser mayor que cero`);
            if (qty > remainingOf(item)) {
              throw unprocessable(`"${item.name}": solo quedan ${fromMilli(remainingOf(item))} por cobrar`);
            }
            return { item, qty };
          })
        : order.items.filter((i) => remainingOf(i) > 0n).map((item) => ({ item, qty: remainingOf(item) }));
      if (selection.length === 0) throw unprocessable("No hay productos por cobrar");
      if (new Set(selection.map((s) => s.item.id)).size !== selection.length) {
        throw unprocessable("Un producto aparece repetido en la selección");
      }

      const input: DocumentInput = {
        type: body.type,
        branchId: order.branchId,
        terminalId: body.terminalId ?? null,
        customerId: body.customerId ?? null,
        buyer: body.buyer ?? null,
        currency: "DOP",
        exchangeRate: "1",
        propinaLegal: body.propinaLegal,
        notes: `${order.table.name} · Comanda #${order.number}`,
        referencedDocumentId: null,
        modificationCode: null,
        lines: selection.map(({ item, qty }) => ({
          productId: item.productId,
          // Opciones y notas del pedido, para que el comprobante diga qué se cobró.
          description:
            [modifiersOf(item).map((m) => m.name).join(", "), item.notes ?? ""].filter(Boolean).join(" · ") || null,
          name: item.name,
          // Se factura al precio y con el impuesto que tenía al anotarse, no al de hoy.
          unitPrice: fromCents(item.unitPrice),
          quantity: fromMilli(qty),
          tax: item.tax,
          priceIncludesTax: item.priceIncludesTax,
        })),
        payments: body.payments,
      };

      const { document, lines, payments } = await buildDraft(tx, input, { allowInactiveProducts: true });
      const draft = await tx.document.create({
        data: {
          ...document,
          organizationId,
          createdById: userId,
          orderId: order.id,
          lines: { create: lines.map((l) => ({ ...l, organizationId })) },
          payments: { create: payments.map((p) => ({ ...p, organizationId })) },
        },
        select: { id: true },
      });
      const issued = await issueDocument(tx, { id: draft.id, organizationId, userId, env: c.get("deps").env });

      // Los componentes de un combo cobrado salen del inventario (el combo mismo no lo lleva).
      const profile = await tx.companyProfile.findFirst({ select: { allowNegativeStock: true } });
      const entries: { productId: string; quantity: bigint }[] = [];
      for (const { item, qty } of selection) {
        for (const part of order.items) {
          if (part.parentItemId !== item.id || part.status === "VOID" || !part.productId) continue;
          entries.push({ productId: part.productId, quantity: (part.quantity * qty) / item.quantity });
        }
      }
      await applyComboStock(tx, {
        organizationId,
        userId,
        branchId: order.branchId,
        documentId: issued.id,
        allowNegative: profile?.allowNegativeStock ?? false,
        reason: "Combo cobrado en la comanda #" + order.number,
        entries,
      });

      // Lo cobrado se descuenta de la comanda; lo que nunca pasó por cocina queda como entregado.
      const now = new Date();
      for (const { item, qty } of selection) {
        await tx.orderItem.update({
          where: { id: item.id },
          data: {
            billedQuantity: { increment: qty },
            ...(item.status === "PENDING" ? { status: "READY", sentAt: now, readyAt: now } : {}),
          },
        });
        if (item.status === "PENDING") {
          await tx.orderItem.updateMany({
            where: { parentItemId: item.id, status: "PENDING" },
            data: { status: "READY", sentAt: now, readyAt: now },
          });
        }
      }

      const after = await loadOrder(tx, id);
      const closed = after.items.every((i) => remainingOf(i) === 0n);
      if (closed) {
        await tx.restaurantOrder.update({ where: { id }, data: { status: "CLOSED", closedAt: now } });
      }
      await tx.auditLog.create({
        data: auditEntry(c, "order.bill", "restaurant_order", id, {
          encf: issued.encf,
          total: fromCents(issued.total),
          closed,
        }),
      });
      const finalOrder = closed ? await loadOrder(tx, id) : after;
      return { issued, order: finalOrder, closed };
    });

    return c.json(
      { data: { document: documentDto(result.issued, await c.get("db").companyProfile.findFirst({ select: { rnc: true, environment: true } })), order: orderDto(result.order), closed: result.closed } },
      201,
    );
  })

  // ───────────── Cocina y bar ─────────────
  // Productos enviados y aún sin marcar como listos, de más antiguo a más reciente.
  .get("/kitchen", zv("query", z.object({ station: stationEnum, branchId: z.uuid().optional() })), async (c) => {
    const { station, branchId } = c.req.valid("query");
    const items = await c.get("db").orderItem.findMany({
      where: {
        status: "SENT",
        station,
        order: { status: "OPEN", ...(branchId ? { branchId } : {}) },
      },
      orderBy: { sentAt: "asc" },
      include: { order: { include: { table: true } }, parent: { select: { name: true } } },
    });

    const groups = new Map<
      string,
      {
        orderId: string;
        number: number;
        table: string;
        zone: string | null;
        sentAt: Date | null;
        items: (ReturnType<typeof itemDto> & { combo: string | null })[];
      }
    >();
    for (const i of items) {
      const g = groups.get(i.orderId) ?? {
        orderId: i.orderId,
        number: i.order.number,
        table: i.order.table.name,
        zone: i.order.table.zone,
        sentAt: i.sentAt,
        items: [],
      };
      g.items.push({ ...itemDto(i), combo: i.parent?.name ?? null });
      groups.set(i.orderId, g);
    }
    return c.json({ data: [...groups.values()] });
  })
  .post("/items/:id/ready", zv("param", uuidParam), async (c) => {
    const { id } = c.req.valid("param");
    await c.get("run")(async (tx) => {
      const item = await tx.orderItem.findFirst({ where: { id } });
      if (!item) throw notFound("Producto");
      if (item.status !== "SENT") throw conflict("Ese producto no está en preparación");
      await tx.orderItem.update({ where: { id }, data: { status: "READY", readyAt: new Date() } });
    });
    return c.body(null, 204);
  });

