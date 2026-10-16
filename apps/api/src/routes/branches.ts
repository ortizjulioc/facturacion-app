import { Hono } from "hono";
import { zv } from "../lib/validator";
import { z } from "zod";
import { auditEntry } from "../lib/audit";
import { optionalText, uuidParam } from "../lib/schemas";
import { requireRole } from "../middleware/tenant";
import type { AppEnv } from "../types";

const code = z
  .string()
  .trim()
  .min(1)
  .max(20)
  .regex(/^[A-Za-z0-9-]+$/, "Solo letras, números y guiones");

const createBranch = z.object({
  name: z.string().trim().min(2).max(120),
  code,
  address: optionalText(250),
});

// El código identifica la sucursal en secuencias y reportes: no se cambia después de creada.
const updateBranch = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  address: optionalText(250).optional(),
  active: z.boolean().optional(),
});

const canWrite = requireRole("owner", "admin");

export const branches = new Hono<AppEnv>()
  .get("/", async (c) => {
    const data = await c.get("db").branch.findMany({ orderBy: { createdAt: "asc" } });
    return c.json({ data });
  })
  .post("/", canWrite, zv("json", createBranch), async (c) => {
    const input = c.req.valid("json");
    const branch = await c.get("run")(async (tx) => {
      const created = await tx.branch.create({
        data: { ...input, organizationId: c.get("organizationId") },
      });
      await tx.auditLog.create({
        data: auditEntry(c, "branch.create", "branch", created.id, { code: created.code }),
      });
      return created;
    });
    return c.json({ data: branch }, 201);
  })
  .patch("/:id", canWrite, zv("param", uuidParam), zv("json", updateBranch), async (c) => {
    const { id } = c.req.valid("param");
    const input = c.req.valid("json");
    const branch = await c.get("run")(async (tx) => {
      const updated = await tx.branch.update({ where: { id }, data: input });
      await tx.auditLog.create({
        data: auditEntry(c, "branch.update", "branch", id, { fields: Object.keys(input) }),
      });
      return updated;
    });
    return c.json({ data: branch });
  });
