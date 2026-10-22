import { serve } from "@hono/node-server";
import { createPrisma } from "@facturacion/db";
import { createApp } from "./app";
import { createAuth } from "./auth";
import { loadEnv } from "./env";
import { createLogger } from "./logger";
import { processDue } from "./lib/fiscal";

const env = loadEnv();
const logger = createLogger(env);
const prisma = createPrisma({ connectionString: env.DATABASE_URL });
const auth = createAuth(prisma, env);
const app = createApp({ env, prisma, auth, logger });

const server = serve({ fetch: app.fetch, port: env.API_PORT, hostname: "0.0.0.0" }, (info) =>
  logger.info(`API escuchando en :${info.port}`),
);

// Trabajador fiscal: cada pocos segundos envía a la DGII lo pendiente y consulta los resultados. Una vuelta a la vez.
let fiscalTimer: NodeJS.Timeout | undefined;
if (env.FISCAL_WORKER === "true") {
  let running = false;
  fiscalTimer = setInterval(() => {
    if (running) return;
    running = true;
    processDue({ env, prisma, logger })
      .catch((err) => logger.error({ err }, "trabajador fiscal"))
      .finally(() => (running = false));
  }, 5_000);
}

// Apagado ordenado: Dokploy envía SIGTERM al redeployar.
const shutdown = async (signal: string) => {
  logger.info({ signal }, "apagando");
  clearInterval(fiscalTimer);
  server.close();
  await prisma.$disconnect();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
