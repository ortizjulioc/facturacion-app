import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

// Todo va dentro de cada bundle: los paquetes del monorepo se publican como TypeScript (Electron no sabría leerlos) y así
// el instalador no arrastra node_modules (por eso todas las dependencias están en devDependencies; solo `electron` queda fuera).
const bundled = ["@facturacion/core", "@facturacion/ecf", "@facturacion/pos-engine", "@facturacion/printing", "electron-updater"];

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
