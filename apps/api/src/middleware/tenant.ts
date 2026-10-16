import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { tenantTransaction, withTenant } from "@facturacion/db";
import type { AppEnv } from "../types";

/**
 * Exige sesión + empresa activa, verifica que el usuario sea miembro y entrega
 * `c.var.db` (cliente ya atado al tenant por RLS) y `c.var.role`.
 */
export const requireTenant = createMiddleware<AppEnv>(async (c, next) => {
  const { auth, prisma } = c.get("deps");
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) throw new HTTPException(401, { message: "No autenticado" });

  const organizationId = session.session.activeOrganizationId;
  if (!organizationId) {
    throw new HTTPException(409, { message: "Selecciona una empresa activa" });
  }

  const member = await prisma.member.findUnique({
    where: { organizationId_userId: { organizationId, userId: session.user.id } },
    select: { role: true },
  });
  if (!member) throw new HTTPException(403, { message: "No perteneces a esta empresa" });

  c.set("user", session.user);
  c.set("organizationId", organizationId);
  c.set("role", member.role);
  c.set("db", withTenant(prisma, organizationId));
  c.set("run", (fn) => tenantTransaction(prisma, organizationId, fn));
  await next();
});

/** Better Auth puede guardar varios roles juntos ("owner,admin"). */
export const requireRole = (...allowed: string[]) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const roles = c
      .get("role")
      .split(",")
      .map((r) => r.trim());
    if (!roles.some((r) => allowed.includes(r))) {
      throw new HTTPException(403, { message: "Permisos insuficientes" });
    }
    await next();
  });
