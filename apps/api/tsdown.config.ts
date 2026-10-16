import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/server.ts"],
  format: "esm",
  platform: "node",
  target: "node24",
  clean: true,
  // Los paquetes del workspace exportan TypeScript: hay que empaquetarlos dentro del bundle.
  deps: { alwaysBundle: [/^@facturacion\//] },
});
