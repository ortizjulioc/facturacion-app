import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { organization } from "better-auth/plugins";
import type { DbClient } from "@facturacion/db";
import { webOrigins, type Env } from "./env";

export function createAuth(prisma: DbClient, env: Env) {
  return betterAuth({
    appName: "Facturación",
    baseURL: env.API_PUBLIC_URL,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: webOrigins(env),
    database: prismaAdapter(prisma, { provider: "postgresql" }),
    emailAndPassword: { enabled: true, minPasswordLength: 10 },
    advanced: {
      useSecureCookies: env.NODE_ENV === "production",
      ...(env.COOKIE_DOMAIN
        ? { crossSubDomainCookies: { enabled: true, domain: env.COOKIE_DOMAIN } }
        : {}),
    },
    plugins: [organization()],
  });
}

export type Auth = ReturnType<typeof createAuth>;
