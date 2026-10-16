import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { branches } from "./routes/branches";
import { requireTenant } from "./middleware/tenant";
import { webOrigins } from "./env";
import type { AppEnv, Deps } from "./types";

export function createApp(deps: Deps) {
  const { env, auth, prisma, logger } = deps;

  const app = new Hono<AppEnv>()
    .use("*", async (c, next) => {
      c.set("deps", deps);
      const started = performance.now();
      await next();
      logger.info(
        {
          method: c.req.method,
          path: c.req.path,
          status: c.res.status,
          ms: Math.round(performance.now() - started),
        },
        "request",
      );
    })
    .use("*", secureHeaders())
    .use(
      "*",
      cors({
        origin: webOrigins(env),
        credentials: true,
        allowHeaders: ["Content-Type", "Authorization"],
        allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      }),
    )
    // Liveness: no toca la BD. Dokploy/Traefik lo usan como health check.
    .get("/health", (c) => c.json({ status: "ok" }))
    // Readiness: confirma conexión a Postgres.
    .get("/ready", async (c) => {
      await prisma.$queryRaw`SELECT 1`;
      return c.json({ status: "ready" });
    })
    .on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw))
    .get("/v1/me", async (c) => {
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      if (!session) throw new HTTPException(401, { message: "No autenticado" });
      return c.json({
        user: session.user,
        activeOrganizationId: session.session.activeOrganizationId ?? null,
      });
    })
    .use("/v1/*", async (c, next) => {
      // /v1/me es la única ruta que no exige empresa activa.
      if (c.req.path === "/v1/me") return next();
      return requireTenant(c, next);
    })
    .route("/v1/branches", branches);

  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    logger.error({ err }, "error no controlado");
    return c.json({ error: "Error interno" }, 500);
  });
  app.notFound((c) => c.json({ error: "No encontrado" }, 404));

  return app;
}

export type AppType = ReturnType<typeof createApp>;
