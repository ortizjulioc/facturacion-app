import { resolve } from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  experimental: {
    agentFeedback: true,
  },
  cacheComponents: true,
  partialPrefetching: true,
  // Imagen Docker mínima para Dokploy: genera .next/standalone con solo lo necesario.
  output: "standalone",
  // En monorepo hay que trazar desde la raíz para incluir los paquetes del workspace.
  outputFileTracingRoot: resolve(import.meta.dirname, "../../"),
  // Los paquetes internos exportan TypeScript sin compilar.
  transpilePackages: ["@facturacion/core"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
