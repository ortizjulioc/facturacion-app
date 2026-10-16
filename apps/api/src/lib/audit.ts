import type { Context } from "hono";
import type { Prisma } from "@facturacion/db";
import type { AppEnv } from "../types";

/** Datos de una fila de bitácora. Se inserta con `tx.auditLog.create` dentro de la misma transacción. */
export function auditEntry(
  c: Context<AppEnv>,
  action: string,
  entity: string,
  entityId: string,
  data?: Prisma.InputJsonValue,
): Prisma.AuditLogUncheckedCreateInput {
  return {
    organizationId: c.get("organizationId"),
    actorUserId: c.get("user").id,
    action,
    entity,
    entityId,
    ...(data === undefined ? {} : { data }),
  };
}
