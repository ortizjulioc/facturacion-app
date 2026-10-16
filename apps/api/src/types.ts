import type { DbClient, Prisma, withTenant } from "@facturacion/db";
import type { Auth } from "./auth";
import type { Env } from "./env";
import type { Logger } from "./logger";

export type Deps = { env: Env; prisma: DbClient; auth: Auth; logger: Logger };

export type TenantTx = Prisma.TransactionClient;

export type AppEnv = {
  Variables: {
    deps: Deps;
    user: Auth["$Infer"]["Session"]["user"];
    organizationId: string;
    role: string;
    /** Cliente atado al tenant: cada operación suelta es su propia transacción. */
    db: ReturnType<typeof withTenant>;
    /** Varias operaciones atómicas bajo el mismo tenant (p. ej. crear + bitácora). */
    run: <T>(fn: (tx: TenantTx) => Promise<T>) => Promise<T>;
  };
};
