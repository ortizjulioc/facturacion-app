import type { Context } from "hono";
import type { Prisma } from "@facturacion/db";
import type { AppEnv } from "../types";

/** Fila de bitácora a partir de quién actúa; sirve también fuera de una petición HTTP. */
export function auditRow(
  actor: { organizationId: string; userId: string },
  action: string,
  entity: string,
  entityId: string,
  data?: Prisma.InputJsonValue,
): Prisma.AuditLogUncheckedCreateInput {
  return {
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    action,
    entity,
    entityId,
    ...(data === undefined ? {} : { data }),
  };
}

/** Datos de una fila de bitácora. Se inserta con `tx.auditLog.create` dentro de la misma transacción. */
export function auditEntry(
  c: Context<AppEnv>,
  action: string,
  entity: string,
  entityId: string,
  data?: Prisma.InputJsonValue,
): Prisma.AuditLogUncheckedCreateInput {
  return auditRow(
    { organizationId: c.get("organizationId"), userId: c.get("user").id },
    action,
    entity,
    entityId,
    data,
  );
}
