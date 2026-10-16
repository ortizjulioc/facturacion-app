import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zv } from "../lib/validator";
import { z } from "zod";
import { DOCUMENT_TYPES, normalizeDocument } from "@facturacion/core";
import type { Prisma } from "@facturacion/db";
import { auditEntry } from "../lib/audit";
import { listQuery, optionalText, pageOf, uuidParam } from "../lib/schemas";
import { requireRole } from "../middleware/tenant";
import type { AppEnv } from "../types";

const documentType = z.enum(DOCUMENT_TYPES);

const base = z.object({
  name: z.string().trim().min(1).max(200),
  documentType: documentType.nullish(),
  documentNumber: z.string().trim().max(30).nullish(),
  email: z.email("Correo inválido").max(200).nullish(),
  phone: optionalText(30),
  address: optionalText(250),
});

type DocFields = { documentType?: string | null; documentNumber?: string | null };

/** Tipo y número van juntos; el número se guarda normalizado (solo dígitos en RNC/cédula). */
function normalizeCustomerDocument<T extends DocFields>(input: T) {
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

const createCustomer = base;
const updateCustomer = base.partial().extend({ active: z.boolean().optional() });

const canWrite = requireRole("owner", "admin", "member");

export const customers = new Hono<AppEnv>()
  .get("/", zv("query", listQuery), async (c) => {
    const { q, page, pageSize, active } = c.req.valid("query");
    const where: Prisma.CustomerWhereInput = {
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
      db.customer.findMany({
        where,
        orderBy: { name: "asc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      db.customer.count({ where }),
    ]);
    return c.json(pageOf(data, total, page, pageSize));
  })
  .get("/:id", zv("param", uuidParam), async (c) => {
    const customer = await c.get("db").customer.findFirst({ where: { id: c.req.valid("param").id } });
    if (!customer) throw new HTTPException(404, { message: "Cliente no encontrado" });
    return c.json({ data: customer });
  })
  .post("/", canWrite, zv("json", createCustomer), async (c) => {
    const input = normalizeCustomerDocument(c.req.valid("json"));
    const customer = await c.get("run")(async (tx) => {
      const created = await tx.customer.create({
        data: { ...input, organizationId: c.get("organizationId") },
      });
      await tx.auditLog.create({
        data: auditEntry(c, "customer.create", "customer", created.id, { name: created.name }),
      });
      return created;
    });
    return c.json({ data: customer }, 201);
  })
  .patch("/:id", canWrite, zv("param", uuidParam), zv("json", updateCustomer), async (c) => {
    const { id } = c.req.valid("param");
    const raw = c.req.valid("json");
    // Solo se normaliza el documento si el cliente envía alguno de los dos campos.
    const touchesDocument = "documentType" in raw || "documentNumber" in raw;
    const input = touchesDocument ? normalizeCustomerDocument(raw) : raw;
    const customer = await c.get("run")(async (tx) => {
      const updated = await tx.customer.update({ where: { id }, data: input });
      await tx.auditLog.create({
        data: auditEntry(c, "customer.update", "customer", id, { fields: Object.keys(raw) }),
      });
      return updated;
    });
    return c.json({ data: customer });
  });
