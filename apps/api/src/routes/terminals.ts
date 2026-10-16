import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zv } from "../lib/validator";
import { z } from "zod";
import { auditEntry } from "../lib/audit";
import { uuidParam } from "../lib/schemas";
import { requireRole } from "../middleware/tenant";
import type { AppEnv } from "../types";

const createTerminal = z.object({
  branchId: z.uuid(),
  name: z.string().trim().min(2).max(120),
  code: z
    .string()
    .trim()
    .min(1)
    .max(20)
    .regex(/^[A-Za-z0-9-]+$/, "Solo letras, números y guiones"),
});

// La sucursal y el código no cambian: las secuencias e-NCF quedan atadas a la caja.
const updateTerminal = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  active: z.boolean().optional(),
});

const canWrite = requireRole("owner", "admin");

export const terminals = new Hono<AppEnv>()
  .get("/", async (c) => {
    const branchId = c.req.query("branchId");
    const data = await c.get("db").terminal.findMany({
      where: branchId ? { branchId } : {},
      orderBy: { createdAt: "asc" },
    });
    return c.json({ data });
  })
  .post("/", canWrite, zv("json", createTerminal), async (c) => {
    const input = c.req.valid("json");
    const terminal = await c.get("run")(async (tx) => {
      // Con RLS, una sucursal de otra empresa no existe para este tenant.
      const branch = await tx.branch.findFirst({ where: { id: input.branchId, active: true } });
      if (!branch) throw new HTTPException(422, { message: "La sucursal no existe o está inactiva" });

      const created = await tx.terminal.create({
        data: { ...input, organizationId: c.get("organizationId") },
      });
      await tx.auditLog.create({
        data: auditEntry(c, "terminal.create", "terminal", created.id, { code: created.code }),
      });
      return created;
    });
    return c.json({ data: terminal }, 201);
  })
  .patch("/:id", canWrite, zv("param", uuidParam), zv("json", updateTerminal), async (c) => {
    const { id } = c.req.valid("param");
    const input = c.req.valid("json");
    const terminal = await c.get("run")(async (tx) => {
      const updated = await tx.terminal.update({ where: { id }, data: input });
      await tx.auditLog.create({
        data: auditEntry(c, "terminal.update", "terminal", id, { fields: Object.keys(input) }),
      });
      return updated;
    });
    return c.json({ data: terminal });
  });
