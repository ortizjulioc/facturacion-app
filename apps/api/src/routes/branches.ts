import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { requireRole } from "../middleware/tenant";
import type { AppEnv } from "../types";

const createBranch = z.object({
  name: z.string().trim().min(2).max(120),
  code: z
    .string()
    .trim()
    .min(1)
    .max(20)
    .regex(/^[A-Za-z0-9-]+$/, "Solo letras, números y guiones"),
  address: z.string().trim().max(250).optional(),
});

export const branches = new Hono<AppEnv>()
  .get("/", async (c) => {
    const rows = await c.get("db").branch.findMany({ orderBy: { createdAt: "asc" } });
    return c.json({ branches: rows });
  })
  .post("/", requireRole("owner", "admin"), zValidator("json", createBranch), async (c) => {
    const input = c.req.valid("json");
    const organizationId = c.get("organizationId");
    const db = c.get("db");

    const exists = await db.branch.findFirst({ where: { code: input.code } });
    if (exists) {
      throw new HTTPException(409, { message: "Ya existe una sucursal con ese código" });
    }

    const branch = await db.branch.create({ data: { ...input, organizationId } });
    await db.auditLog.create({
      data: {
        organizationId,
        actorUserId: c.get("user").id,
        action: "branch.create",
        entity: "branch",
        entityId: branch.id,
        data: { code: branch.code, name: branch.name },
      },
    });
    return c.json({ branch }, 201);
  });
