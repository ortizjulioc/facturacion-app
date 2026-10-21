import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { hashPin, pinProblem } from "@facturacion/core";
import { auditEntry } from "../lib/audit";
import { zv } from "../lib/validator";
import { requireRole } from "../middleware/tenant";
import type { AppEnv } from "../types";

/**
 * PIN de cajero: lo que usa una persona para identificarse en la caja (también sin internet; ver `lib/pin` en core).
 * Cada quien define el suyo; un administrador puede definir o quitar el de cualquiera de su empresa.
 */

const isAdmin = (role: string) => role.split(",").some((r) => ["owner", "admin"].includes(r.trim()));

const pinBody = z.object({
  pin: z.string().refine((v) => pinProblem(v) === null, { error: (iss) => pinProblem(String(iss.input)) ?? "PIN inválido" }),
});
const userParam = z.object({ userId: z.string().min(1).max(64) });

export const pins = new Hono<AppEnv>()
  // Quién tiene PIN en la empresa (nunca el PIN ni su resumen).
  .get("/", requireRole("owner", "admin"), async (c) => {
    const { prisma } = c.get("deps");
    const organizationId = c.get("organizationId");
    const [members, withPin] = await Promise.all([
      prisma.member.findMany({ where: { organizationId }, include: { user: { select: { id: true, name: true, email: true } } }, orderBy: { createdAt: "asc" } }),
      c.get("db").cashierPin.findMany({ select: { userId: true, updatedAt: true } }),
    ]);
    const updated = new Map(withPin.map((p) => [p.userId, p.updatedAt]));
    return c.json({
      data: members.map((m) => ({
        userId: m.userId,
        name: m.user.name,
        email: m.user.email,
        role: m.role,
        hasPin: updated.has(m.userId),
        pinUpdatedAt: updated.get(m.userId) ?? null,
      })),
    });
  })
  .put("/me", zv("json", pinBody), async (c) => {
    await save(c, c.get("user").id, c.req.valid("json").pin);
    return c.body(null, 204);
  })
  .put("/:userId", requireRole("owner", "admin"), zv("param", userParam), zv("json", pinBody), async (c) => {
    const { userId } = c.req.valid("param");
    const member = await c.get("deps").prisma.member.findUnique({
      where: { organizationId_userId: { organizationId: c.get("organizationId"), userId } },
      select: { userId: true },
    });
    if (!member) throw new HTTPException(404, { message: "Esa persona no pertenece a la empresa" });
    await save(c, userId, c.req.valid("json").pin);
    return c.body(null, 204);
  })
  .delete("/:userId", zv("param", userParam), async (c) => {
    const { userId } = c.req.valid("param");
    if (userId !== c.get("user").id && !isAdmin(c.get("role"))) {
      throw new HTTPException(403, { message: "Solo un administrador puede quitar el PIN de otra persona" });
    }
    await c.get("run")(async (tx) => {
      const { count } = await tx.cashierPin.deleteMany({ where: { userId } });
      if (count === 0) throw new HTTPException(404, { message: "Esa persona no tiene PIN" });
      await tx.auditLog.create({ data: auditEntry(c, "pin.delete", "cashier_pin", userId) });
    });
    return c.body(null, 204);
  });

async function save(c: Parameters<typeof auditEntry>[0], userId: string, pin: string) {
  const pinHash = await hashPin(pin);
  const organizationId = c.get("organizationId");
  await c.get("run")(async (tx) => {
    await tx.cashierPin.upsert({
      where: { organizationId_userId: { organizationId, userId } },
      create: { organizationId, userId, pinHash },
      update: { pinHash },
    });
    await tx.auditLog.create({ data: auditEntry(c, "pin.set", "cashier_pin", userId) });
  });
}
