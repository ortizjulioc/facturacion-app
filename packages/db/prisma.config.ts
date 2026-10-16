import { resolve } from "node:path";
import { config } from "dotenv";
import { defineConfig } from "prisma/config";

// El .env vive en la raíz del monorepo.
config({ path: resolve(import.meta.dirname, "../../.env"), quiet: true });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: {
    // Las migraciones corren con el dueño de las tablas; la app usa DATABASE_URL (rol sin privilegios).
    url: process.env.DATABASE_URL_MIGRATE ?? process.env.DATABASE_URL ?? "",
  },
});
