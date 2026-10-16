import { createAuthClient } from "better-auth/react";
import { organizationClient } from "better-auth/client/plugins";
import { hc } from "hono/client";
import type { AppType } from "@facturacion/api";

/** URL pública de la API (visible en el navegador). */
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

/** Cliente de autenticación (sesiones por cookie contra la API). */
export const authClient = createAuthClient({
  baseURL: API_URL,
  plugins: [organizationClient()],
});

/** Cliente tipado de la API: los tipos vienen directamente de las rutas Hono. */
export const api = hc<AppType>(API_URL, {
  init: { credentials: "include" },
});
