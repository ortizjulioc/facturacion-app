/**
 * Prepara la base de datos de DESARROLLO en un Postgres ya instalado:
 *   1. crea la base `facturacion` si no existe,
 *   2. crea los roles facturacion_migrator / facturacion_app (setup-roles.sql),
 *   3. completa el .env de la raíz con DATABASE_URL, DATABASE_URL_MIGRATE y BETTER_AUTH_SECRET.
 *
 * Requiere en el .env una sola línea con un usuario administrador (solo para este script):
 *   DATABASE_URL_ADMIN="postgresql://postgres:TU_CLAVE@localhost:5432/postgres"
 *
 * Uso:  pnpm db:bootstrap
 * No imprime contraseñas.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "dotenv";
import pg from "pg";

const root = resolve(import.meta.dirname, "../../..");
const envPath = resolve(root, ".env");
config({ path: envPath, quiet: true });

const DB_NAME = process.env.BOOTSTRAP_DB_NAME ?? "facturacion";
const adminUrl = process.env.DATABASE_URL_ADMIN;
if (!adminUrl) {
  console.error(
    'Falta DATABASE_URL_ADMIN en .env, por ejemplo:\n  DATABASE_URL_ADMIN="postgresql://postgres:TU_CLAVE@localhost:5432/postgres"',
  );
  process.exit(1);
}

const admin = new URL(adminUrl);
const pgEnv = (database: string) => ({
  ...process.env,
  PGHOST: admin.hostname,
  PGPORT: admin.port || "5432",
  PGUSER: decodeURIComponent(admin.username),
  PGPASSWORD: decodeURIComponent(admin.password),
  PGDATABASE: database,
});

// Contraseñas: se reutilizan las de un .env previo; si no, se generan.
const existing = (key: string) => {
  const v = process.env[key];
  return v ? new URL(v).password : undefined;
};
const migratorPassword = existing("DATABASE_URL_MIGRATE") ?? randomBytes(18).toString("hex");
const appPassword = existing("DATABASE_URL") ?? randomBytes(18).toString("hex");

// 1) Crear la base si no existe.
const client = new pg.Client({ connectionString: adminUrl });
await client.connect();
const found = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [DB_NAME]);
if (found.rowCount === 0) {
  await client.query(`CREATE DATABASE "${DB_NAME}"`);
  console.log(`✔ Base de datos "${DB_NAME}" creada`);
} else {
  console.log(`• Base de datos "${DB_NAME}" ya existía`);
}
await client.end();

// 2) Roles (psql, para reutilizar el mismo SQL que producción y CI).
execFileSync(
  "psql",
  [
    "-v", "ON_ERROR_STOP=1",
    "-q",
    "-v", `dbname=${DB_NAME}`,
    "-v", `migrator_password='${migratorPassword}'`,
    "-v", `app_password='${appPassword}'`,
    "-f", resolve(import.meta.dirname, "setup-roles.sql"),
  ],
  { env: pgEnv(DB_NAME), stdio: ["ignore", "inherit", "inherit"] },
);
console.log("✔ Roles facturacion_migrator y facturacion_app listos");

// 3) Completar el .env sin pisar valores existentes.
const host = `${admin.hostname}:${admin.port || "5432"}`;
const wanted: Record<string, string> = {
  DATABASE_URL: `postgresql://facturacion_app:${appPassword}@${host}/${DB_NAME}`,
  DATABASE_URL_MIGRATE: `postgresql://facturacion_migrator:${migratorPassword}@${host}/${DB_NAME}`,
  BETTER_AUTH_SECRET: randomBytes(32).toString("base64"),
};
let content = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
const added: string[] = [];
for (const [key, value] of Object.entries(wanted)) {
  if (new RegExp(`^${key}=`, "m").test(content)) continue;
  content += `${content && !content.endsWith("\n") ? "\n" : ""}${key}="${value}"\n`;
  added.push(key);
}
writeFileSync(envPath, content);
console.log(added.length ? `✔ .env actualizado: ${added.join(", ")}` : "• .env ya estaba completo");
