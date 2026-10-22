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
  /**
   * Llave con la que se cifran los certificados digitales (.p12): 32 bytes en base64 o 64 caracteres hex.
   * En desarrollo y pruebas, si falta, se deriva de BETTER_AUTH_SECRET; en producción es obligatoria.
   */
  CERT_ENCRYPTION_KEY: z.string().optional(),
  /** Trabajador que envía los e-CF a la DGII y consulta sus resultados (se apaga con "false", p. ej. en una réplica). */
  FISCAL_WORKER: z.enum(["true", "false"]).default("true"),
}).superRefine((v, ctx) => {
  if (v.NODE_ENV === "production" && !v.CERT_ENCRYPTION_KEY) {
    ctx.addIssue({ code: "custom", path: ["CERT_ENCRYPTION_KEY"], message: "Es obligatoria en producción" });
  }
  if (v.CERT_ENCRYPTION_KEY && !/^([0-9a-fA-F]{64}|[A-Za-z0-9+/]{43}=)$/.test(v.CERT_ENCRYPTION_KEY)) {
    ctx.addIssue({ code: "custom", path: ["CERT_ENCRYPTION_KEY"], message: "Debe ser de 32 bytes, en base64 o hex" });
  }
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

/** Origen con el que la app de caja (Electron) se identifica: un esquema propio que ninguna página web puede usar. */
export const POS_ORIGIN = "app://facturacion-pos";

export const webOrigins = (env: Env) => [
  ...env.WEB_ORIGIN.split(",")
    .map((o) => o.trim())
    .filter(Boolean),
  POS_ORIGIN,
];
