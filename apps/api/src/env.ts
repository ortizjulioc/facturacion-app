import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_PORT: z.coerce.number().int().default(3001),
  DATABASE_URL: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().min(16),
  /** URL pública de esta API (Better Auth la usa para callbacks y cookies). */
  API_PUBLIC_URL: z.url().default("http://localhost:3001"),
  /** Origen(es) del back-office, separados por coma (CORS + trustedOrigins). */
  WEB_ORIGIN: z.string().default("http://localhost:3000"),
  /** Dominio padre para compartir cookie entre app.* y api.* (ej: ".tudominio.com"). Vacío en local. */
  COOKIE_DOMAIN: z.string().optional(),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Variables de entorno inválidas:\n${detail.join("\n")}`);
  }
  return parsed.data;
}

export const webOrigins = (env: Env) =>
  env.WEB_ORIGIN.split(",")
    .map((o) => o.trim())
    .filter(Boolean);
