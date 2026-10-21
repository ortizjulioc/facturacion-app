import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

// Los paquetes del monorepo se publican como TypeScript, así que se compilan dentro de cada bundle
// (no se dejan como dependencias externas que Electron no sabría leer).
const bundled = ["@facturacion/core", "@facturacion/pos-engine"];

export default defineConfig({
  main: {
    build: {
      externalizeDeps: { exclude: bundled },
      rollupOptions: { input: { index: resolve(import.meta.dirname, "src/main/index.ts") } },
    },
  },
  preload: {
    build: {
      externalizeDeps: { exclude: bundled },
      rollupOptions: { input: { index: resolve(import.meta.dirname, "src/preload/index.ts") }, output: { format: "cjs", entryFileNames: "[name].cjs" } },
    },
  },
  renderer: {
    plugins: [react()],
    build: {
      rollupOptions: { input: { index: resolve(import.meta.dirname, "src/renderer/index.html") } },
    },
  },
});
