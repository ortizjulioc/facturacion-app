import { serve } from "@hono/node-server";
import { createPrisma } from "@facturacion/db";
import { createApp } from "./app";
import { createAuth } from "./auth";
import { loadEnv } from "./env";
import { createLogger } from "./logger";

const env = loadEnv();
const logger = createLogger(env);
const prisma = createPrisma({ connectionString: env.DATABASE_URL });
const auth = createAuth(prisma, env);
const app = createApp({ env, prisma, auth, logger });

const server = serve({ fetch: app.fetch, port: env.API_PORT, hostname: "0.0.0.0" }, (info) =>
  logger.info(`API escuchando en :${info.port}`),
);

// Apagado ordenado: Dokploy envía SIGTERM al redeployar.
const shutdown = async (signal: string) => {
  logger.info({ signal }, "apagando");
  server.close();
  await prisma.$disconnect();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
