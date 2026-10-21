import { HTTPException } from "hono/http-exception";
import { formatEncf, type AnyEcfType } from "@facturacion/core";
import type { TenantTx } from "../types";

/**
 * Toma el siguiente número de una secuencia vigente y devuelve el e-NCF completo.
 *
 * Es atómico: el `UPDATE … WHERE id = (SELECT … FOR UPDATE)` bloquea la fila del rango, así que
 * dos cajas emitiendo a la vez nunca obtienen el mismo número. Si la transacción que lo llama
 * falla, el avance de la secuencia se revierte con ella (no se "queman" números).
 *
 * Prioridad: rango propio de la caja → rango general de la empresa; el que vence primero.
 */
export async function allocateEncf(
  tx: TenantTx,
  type: AnyEcfType,
  terminalId: string | null,
): Promise<string> {
  const rows = await tx.$queryRaw<{ n: bigint }[]>`
    UPDATE "sequence"
    SET "nextNumber" = "nextNumber" + 1, "updatedAt" = now()
    WHERE "id" = (
      SELECT "id" FROM "sequence"
      WHERE "ecfType" = ${type}::"EcfType"
        AND "active"
        AND NOT "offline"
        AND "nextNumber" <= "toNumber"
        AND "expiresAt" >= (now() AT TIME ZONE 'America/Santo_Domingo')::date
        AND ("terminalId" IS NULL OR "terminalId" = ${terminalId}::uuid)
      ORDER BY ("terminalId" IS NULL), "expiresAt", "fromNumber"
      LIMIT 1
      FOR UPDATE
    )
    RETURNING "nextNumber" - 1 AS n
  `;

  const row = rows[0];
  if (!row) {
    throw new HTTPException(422, {
      message: `No hay una secuencia vigente con números disponibles para ${type}. Registra un rango autorizado por la DGII.`,
    });
  }
  return formatEncf(type, BigInt(row.n));
}
