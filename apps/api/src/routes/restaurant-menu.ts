import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { fromCents, toCents } from "@facturacion/core";
import type { Prisma } from "@facturacion/db";
import { auditEntry } from "../lib/audit";
import { money, uuidParam } from "../lib/schemas";
import { zv } from "../lib/validator";
import { requireRole } from "../middleware/tenant";
import type { AppEnv } from "../types";

const unprocessable = (message: string) => new HTTPException(422, { message });
const adminOnly = requireRole("owner", "admin");

const isAdmin = (role: string) => role.split(",").some((r) => ["owner", "admin"].includes(r.trim()));

// ───────────── Esquemas ─────────────

const groupBody = z
  .object({
    name: z.string().trim().min(1).max(80),
    /** Cuántas opciones hay que elegir como mínimo (0 = opcional) y como máximo. */
    minSelect: z.number().int().min(0).max(20).default(0),
    maxSelect: z.number().int().min(1).max(20).default(1),
    active: z.boolean().default(true),
    modifiers: z
      .array(
        z.object({
          id: z.uuid().optional(),
          name: z.string().trim().min(1).max(80),
          price: money.default("0"),
          active: z.boolean().default(true),
        }),
      )
      .min(1, "Agrega al menos una opción")
      .max(50),
  })
  .superRefine((v, ctx) => {
    if (v.maxSelect < v.minSelect) {
      ctx.addIssue({ code: "custom", path: ["maxSelect"], message: "El máximo no puede ser menor que el mínimo" });
    }
    const names = v.modifiers.map((m) => m.name.toLowerCase());
    if (new Set(names).size !== names.length) {
      ctx.addIssue({ code: "custom", path: ["modifiers"], message: "Hay opciones con el mismo nombre" });
    }
    if (v.minSelect > v.modifiers.filter((m) => m.active).length) {
      ctx.addIssue({ code: "custom", path: ["minSelect"], message: "Hay menos opciones activas que el mínimo a elegir" });
    }
  });

const menuConfigBody = z.object({
  modifierGroupIds: z.array(z.uuid()).max(10).default([]),
  /** Si trae componentes, el producto es un combo. Vacío: deja de serlo. */
  components: z
    .array(z.object({ productId: z.uuid(), quantity: z.number().int().min(1).max(999) }))
    .max(30)
    .default([]),
});

const menuQuery = z.object({
  q: z.string().trim().max(100).optional(),
  categoryId: z.uuid().optional(),
});

// ───────────── Ayudas ─────────────

type GroupRow = Prisma.ModifierGroupGetPayload<{ include: { modifiers: true; _count: { select: { products: true } } } }>;

const GROUP_INCLUDE = {
  modifiers: { orderBy: [{ sortOrder: "asc" }, { name: "asc" }] },
  _count: { select: { products: true } },
} satisfies Prisma.ModifierGroupInclude;

const groupDto = (g: GroupRow) => ({
  id: g.id,
  name: g.name,
  minSelect: g.minSelect,
  maxSelect: g.maxSelect,
  active: g.active,
  products: g._count.products,
  modifiers: g.modifiers.map((m) => ({ id: m.id, name: m.name, price: fromCents(m.price), active: m.active })),
});

export const restaurantMenu = new Hono<AppEnv>()
  // ───────────── Grupos de modificadores ─────────────
  .get("/modifier-groups", async (c) => {
    const all = c.req.query("all") === "true" && isAdmin(c.get("role"));
    const groups = await c.get("db").modifierGroup.findMany({
      where: all ? {} : { active: true },
      orderBy: { name: "asc" },
      include: GROUP_INCLUDE,
    });
    return c.json({ data: groups.map(groupDto) });
  })
  .post("/modifier-groups", adminOnly, zv("json", groupBody), async (c) => {
    const input = c.req.valid("json");
    const organizationId = c.get("organizationId");
    const group = await c.get("run")(async (tx) => {
      const created = await tx.modifierGroup.create({
        data: {
          organizationId,
          name: input.name,
          minSelect: input.minSelect,
          maxSelect: input.maxSelect,
          active: input.active,
          modifiers: {
            create: input.modifiers.map((m, i) => ({
              organizationId,
              name: m.name,
              price: toCents(m.price),
              active: m.active,
              sortOrder: i,
            })),
          },
        },
        include: GROUP_INCLUDE,
      });
      await tx.auditLog.create({
        data: auditEntry(c, "modifier_group.create", "modifier_group", created.id, { name: created.name }),
      });
      return created;
    });
    return c.json({ data: groupDto(group) }, 201);
  })
  // Reemplaza el contenido del grupo: las opciones con `id` se actualizan, las nuevas se crean y las
  // que ya no vienen se borran (las comandas guardan una copia, así que no se afectan).
  .put("/modifier-groups/:id", adminOnly, zv("param", uuidParam), zv("json", groupBody), async (c) => {
    const { id } = c.req.valid("param");
    const input = c.req.valid("json");
    const organizationId = c.get("organizationId");
    const group = await c.get("run")(async (tx) => {
      const existing = await tx.modifierGroup.findFirst({ where: { id }, include: { modifiers: true } });
      if (!existing) throw new HTTPException(404, { message: "Grupo no encontrado" });

      const known = new Set(existing.modifiers.map((m) => m.id));
      if (input.modifiers.some((m) => m.id && !known.has(m.id))) {
        throw unprocessable("Una de las opciones no pertenece a este grupo");
      }
      const keep = new Set(input.modifiers.flatMap((m) => (m.id ? [m.id] : [])));
      await tx.modifier.deleteMany({ where: { groupId: id, id: { notIn: [...keep] } } });

      // Primero se liberan los nombres (un intercambio A↔B chocaría con la unicidad), luego se escribe lo nuevo.
      for (const m of input.modifiers.filter((x) => x.id)) {
        await tx.modifier.update({ where: { id: m.id! }, data: { name: `~${m.id}` } });
      }
      for (const [i, m] of input.modifiers.entries()) {
        const data = { name: m.name, price: toCents(m.price), active: m.active, sortOrder: i };
        if (m.id) await tx.modifier.update({ where: { id: m.id }, data });
        else await tx.modifier.create({ data: { ...data, organizationId, groupId: id } });
      }
      await tx.modifierGroup.update({
        where: { id },
        data: { name: input.name, minSelect: input.minSelect, maxSelect: input.maxSelect, active: input.active },
      });
      await tx.auditLog.create({
        data: auditEntry(c, "modifier_group.update", "modifier_group", id, { name: input.name }),
      });
      return tx.modifierGroup.findFirstOrThrow({ where: { id }, include: GROUP_INCLUDE });
    });
    return c.json({ data: groupDto(group) });
  })
  .delete("/modifier-groups/:id", adminOnly, zv("param", uuidParam), async (c) => {
    const { id } = c.req.valid("param");
    await c.get("run")(async (tx) => {
      const existing = await tx.modifierGroup.findFirst({ where: { id } });
      if (!existing) throw new HTTPException(404, { message: "Grupo no encontrado" });
      await tx.modifierGroup.delete({ where: { id } });
      await tx.auditLog.create({
        data: auditEntry(c, "modifier_group.delete", "modifier_group", id, { name: existing.name }),
      });
    });
    return c.body(null, 204);
  })

  // ───────────── Configuración de un producto: modificadores y combo ─────────────
  .get("/products/:id/menu", zv("param", uuidParam), async (c) => {
    const { id } = c.req.valid("param");
    const product = await c.get("db").product.findFirst({
      where: { id },
      include: {
        modifierGroups: { orderBy: { sortOrder: "asc" } },
        comboComponents: { include: { product: { select: { name: true } } } },
      },
    });
    if (!product) throw new HTTPException(404, { message: "Producto no encontrado" });
    return c.json({
      data: {
        isCombo: product.isCombo,
        modifierGroupIds: product.modifierGroups.map((g) => g.groupId),
        components: product.comboComponents.map((k) => ({
          productId: k.productId,
          name: k.product.name,
          quantity: k.quantity,
        })),
      },
    });
  })
  .put("/products/:id/menu", adminOnly, zv("param", uuidParam), zv("json", menuConfigBody), async (c) => {
    const { id } = c.req.valid("param");
    const input = c.req.valid("json");
    const organizationId = c.get("organizationId");

    await c.get("run")(async (tx) => {
      const product = await tx.product.findFirst({ where: { id } });
      if (!product) throw new HTTPException(404, { message: "Producto no encontrado" });

      const groupIds = [...new Set(input.modifierGroupIds)];
      if (groupIds.length > 0) {
        const found = await tx.modifierGroup.count({ where: { id: { in: groupIds } } });
        if (found !== groupIds.length) throw unprocessable("Uno de los grupos de modificadores no existe");
      }

      const isCombo = input.components.length > 0;
      if (isCombo) {
        const ids = input.components.map((k) => k.productId);
        if (new Set(ids).size !== ids.length) throw unprocessable("Un producto aparece repetido en el combo");
        if (ids.includes(id)) throw unprocessable("Un combo no puede incluirse a sí mismo");
        if (product.trackInventory) {
          throw unprocessable("Un combo no lleva inventario propio: desactiva «Controlar inventario» en el producto");
        }
        if (groupIds.length > 0) throw unprocessable("Un combo no admite modificadores");
        if ((await tx.comboComponent.count({ where: { productId: id } })) > 0) {
          throw unprocessable("Este producto forma parte de otro combo y no puede ser un combo");
        }
        const parts = await tx.product.findMany({ where: { id: { in: ids }, active: true } });
        if (parts.length !== ids.length) throw unprocessable("Uno de los componentes no existe o está inactivo");
        if (parts.some((p) => p.isCombo)) throw unprocessable("Un combo no puede contener otro combo");
        if (parts.some((p) => p.allowsDecimals)) {
          throw unprocessable("Los productos que se venden por peso o fracciones no pueden ser parte de un combo");
        }
      }

      await tx.productModifierGroup.deleteMany({ where: { productId: id } });
      await tx.comboComponent.deleteMany({ where: { comboId: id } });
      if (groupIds.length > 0) {
        await tx.productModifierGroup.createMany({
          data: groupIds.map((groupId, i) => ({ organizationId, productId: id, groupId, sortOrder: i })),
        });
      }
      if (isCombo) {
        await tx.comboComponent.createMany({
          data: input.components.map((k) => ({
            organizationId,
            comboId: id,
            productId: k.productId,
            quantity: k.quantity,
          })),
        });
      }
      await tx.product.update({ where: { id }, data: { isCombo } });
      await tx.auditLog.create({
        data: auditEntry(c, "product.menu", "product", id, {
          name: product.name,
          groups: groupIds.length,
          components: input.components.length,
        }),
      });
    });
    return c.body(null, 204);
  })

  // ───────────── Carta para anotar pedidos ─────────────
  // Productos activos con sus modificadores y, si son combos, sus componentes.
  .get("/menu", zv("query", menuQuery), async (c) => {
    const { q, categoryId } = c.req.valid("query");
    const products = await c.get("db").product.findMany({
      where: {
        active: true,
        ...(categoryId ? { categoryId } : {}),
        ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { sku: { contains: q, mode: "insensitive" } }] } : {}),
      },
      orderBy: { name: "asc" },
      take: 200,
      include: {
        modifierGroups: {
          orderBy: { sortOrder: "asc" },
          include: { group: { include: { modifiers: { where: { active: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] } } } },
        },
        comboComponents: { include: { product: { select: { name: true } } } },
      },
    });
    return c.json({
      data: products.map((p) => ({
        id: p.id,
        name: p.name,
        categoryId: p.categoryId,
        price: fromCents(p.price),
        prepStation: p.prepStation,
        course: p.course,
        isCombo: p.isCombo,
        modifierGroups: p.modifierGroups
          .filter((pg) => pg.group.active && pg.group.modifiers.length > 0)
          .map((pg) => ({
            id: pg.group.id,
            name: pg.group.name,
            minSelect: pg.group.minSelect,
            maxSelect: pg.group.maxSelect,
            modifiers: pg.group.modifiers.map((m) => ({ id: m.id, name: m.name, price: fromCents(m.price) })),
          })),
        components: p.comboComponents.map((k) => ({ productId: k.productId, name: k.product.name, quantity: k.quantity })),
      })),
    });
  });
