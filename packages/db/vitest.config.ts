import { resolve } from "node:path";
import { config } from "dotenv";
import { defineConfig } from "vitest/config";

config({ path: resolve(import.meta.dirname, "../../.env"), quiet: true });

export default defineConfig({
  test: { include: ["src/**/*.test.ts"], testTimeout: 20_000 },
});
