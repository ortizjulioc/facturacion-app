import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { DOCUMENT_TYPES, normalizeDocument } from "@facturacion/core";
import type { Prisma } from "@facturacion/db";
import { auditEntry } from "../lib/audit";
import { listQuery, optionalText, pageOf, uuidParam } from "../lib/schemas";
import { zv } from "../lib/validator";
import { requireRole } from "../middleware/tenant";
import type { AppEnv } from "../types";

const base = z.object({
  name: z.string().trim().min(1).max(200),
  documentType: z.enum(DOCUMENT_TYPES).nullish(),
  documentNumber: z.string().trim().max(30).nullish(),
  email: z.email("Correo inválido").max(200).nullish(),
  phone: optionalText(30),
  address: optionalText(250),
});

type DocFields = { documentType?: string | null; documentNumber?: string | null };

/** Tipo y número van juntos; el número se guarda normalizado (solo dígitos en RNC/cédula). */
function normalizeSupplierDocument<T extends DocFields>(input: T) {
  const hasType = Boolean(input.documentType);
  const hasNumber = Boolean(input.documentNumber);
  if (hasType !== hasNumber) {
    throw new HTTPException(422, { message: "Indica el tipo y el número de documento" });
  }
  if (!hasType) return { ...input, documentType: null, documentNumber: null };

  const normalized = normalizeDocument(
    input.documentType as (typeof DOCUMENT_TYPES)[number],
    input.documentNumber as string,
  );
  if (!normalized.ok) throw new HTTPException(422, { message: normalized.error });
  return { ...input, documentNumber: normalized.value };
}

const updateSupplier = base.partial().extend({ active: z.boolean().optional() });

// Las compras son del administrador: el cajero no ve proveedores ni costos.
export const suppliers = new Hono<AppEnv>()
  .use("*", requireRole("owner", "admin"))
  .get("/", zv("query", listQuery), async (c) => {
    const { q, page, pageSize, active } = c.req.valid("query");
    const where: Prisma.SupplierWhereInput = {
      ...(active === undefined ? {} : { active }),
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: "insensitive" } },
              { documentNumber: { contains: q.replace(/[\s-]/g, "") } },
              { email: { contains: q, mode: "insensitive" } },
            ],
          }
        : {}),
    };
    const db = c.get("db");
    const [data, total] = await Promise.all([
      db.supplier.findMany({
        where,
        orderBy: { name: "asc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      db.supplier.count({ where }),
    ]);
    return c.json(pageOf(data, total, page, pageSize));
  })
  .get("/:id", zv("param", uuidParam), async (c) => {
    const supplier = await c
      .get("db")
      .supplier.findFirst({ where: { id: c.req.valid("param").id } });
    if (!supplier) throw new HTTPException(404, { message: "Proveedor no encontrado" });
    return c.json({ data: supplier });
  })
  .post("/", zv("json", base), async (c) => {
    const input = normalizeSupplierDocument(c.req.valid("json"));
    const supplier = await c.get("run")(async (tx) => {
      const created = await tx.supplier.create({
        data: { ...input, organizationId: c.get("organizationId") },
      });
      await tx.auditLog.create({
        data: auditEntry(c, "supplier.create", "supplier", created.id, {
          name: created.name,
        }),
      });
      return created;
    });
    return c.json({ data: supplier }, 201);
  })
  .patch("/:id", zv("param", uuidParam), zv("json", updateSupplier), async (c) => {
    const { id } = c.req.valid("param");
    const raw = c.req.valid("json");
    const touchesDocument = "documentType" in raw || "documentNumber" in raw;
    const input = touchesDocument ? normalizeSupplierDocument(raw) : raw;
    const supplier = await c.get("run")(async (tx) => {
      const updated = await tx.supplier.update({ where: { id }, data: input });
      await tx.auditLog.create({
        data: auditEntry(c, "supplier.update", "supplier", id, {
          fields: Object.keys(raw),
        }),
      });
      return updated;
    });
    return c.json({ data: supplier });
  });
