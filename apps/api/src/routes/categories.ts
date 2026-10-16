import { Hono } from "hono";
import { zv } from "../lib/validator";
import { z } from "zod";
import { auditEntry } from "../lib/audit";
import { uuidParam } from "../lib/schemas";
import { requireRole } from "../middleware/tenant";
import type { AppEnv } from "../types";

const name = z.string().trim().min(1).max(80);
const createCategory = z.object({ name });
const updateCategory = z.object({ name: name.optional(), active: z.boolean().optional() });

const canWrite = requireRole("owner", "admin");

export const categories = new Hono<AppEnv>()
  .get("/", async (c) => {
    const data = await c.get("db").category.findMany({ orderBy: { name: "asc" } });
    return c.json({ data });
  })
  .post("/", canWrite, zv("json", createCategory), async (c) => {
    const input = c.req.valid("json");
    const category = await c.get("run")(async (tx) => {
      const created = await tx.category.create({
        data: { ...input, organizationId: c.get("organizationId") },
      });
      await tx.auditLog.create({
        data: auditEntry(c, "category.create", "category", created.id, { name: created.name }),
      });
      return created;
    });
    return c.json({ data: category }, 201);
  })
  .patch("/:id", canWrite, zv("param", uuidParam), zv("json", updateCategory), async (c) => {
    const { id } = c.req.valid("param");
    const input = c.req.valid("json");
    const category = await c.get("run")(async (tx) => {
      const updated = await tx.category.update({ where: { id }, data: input });
      await tx.auditLog.create({
        data: auditEntry(c, "category.update", "category", id, { fields: Object.keys(input) }),
      });
      return updated;
    });
    return c.json({ data: category });
  })
  // Borrar una categoría deja sus productos sin categoría (ON DELETE SET NULL).
  .delete("/:id", canWrite, zv("param", uuidParam), async (c) => {
    const { id } = c.req.valid("param");
    await c.get("run")(async (tx) => {
      await tx.category.delete({ where: { id } });
      await tx.auditLog.create({ data: auditEntry(c, "category.delete", "category", id) });
    });
    return c.body(null, 204);
  });
