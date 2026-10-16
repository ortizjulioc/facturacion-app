import type { DbClient, withTenant } from "@facturacion/db";
import type { Auth } from "./auth";
import type { Env } from "./env";
import type { Logger } from "./logger";

export type Deps = { env: Env; prisma: DbClient; auth: Auth; logger: Logger };

export type AppEnv = {
  Variables: {
    deps: Deps;
    user: Auth["$Infer"]["Session"]["user"];
    organizationId: string;
    role: string;
    db: ReturnType<typeof withTenant>;
  };
};
