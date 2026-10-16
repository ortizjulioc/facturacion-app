import type { Prisma } from "./generated/client";
import type { DbClient } from "./client";

/**
 * Multiempresa con Row-Level Security.
 *
 * Postgres filtra cada tabla de negocio con `organization_id = current_setting('app.tenant_id')`.
 * Estas utilidades fijan esa variable DENTRO de la misma transacción que la consulta, para que
 * un `where` olvidado nunca exponga datos de otra empresa. Sin tenant fijado, las consultas
 * no devuelven filas (falla cerrado).
 */

/** Cliente con el tenant aplicado automáticamente a cada operación. */
export function withTenant(client: DbClient, organizationId: string) {
  assertTenantId(organizationId);
  return client.$extends({
    name: "tenant-rls",
    query: {
      $allModels: {
        async $allOperations({ args, query }) {
          const [, result] = await client.$transaction([
            client.$executeRaw`SELECT set_config('app.tenant_id', ${organizationId}, TRUE)`,
            query(args),
          ]);
          return result;
        },
      },
    },
  });
}

/** Para varias operaciones atómicas bajo el mismo tenant. */
export async function tenantTransaction<T>(
  client: DbClient,
  organizationId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  assertTenantId(organizationId);
  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${organizationId}, TRUE)`;
    return fn(tx);
  });
}

function assertTenantId(id: string) {
  if (!id || id.length > 128) throw new Error("organizationId inválido");
}
