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

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

type AnyResponse = { ok: boolean; status: number; json(): Promise<unknown> };
type Body<R extends AnyResponse> = Awaited<ReturnType<R["json"]>>;

/**
 * Convierte una respuesta del cliente tipado en datos o lanza `ApiError` con el mensaje de la API.
 * Deja fuera del tipo de retorno las respuestas de error (`{ error }`).
 */
export async function unwrap<R extends AnyResponse>(
  res: R,
): Promise<Exclude<Body<R>, { error: string }>> {
  if (res.ok) return (await res.json()) as Exclude<Body<R>, { error: string }>;
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  throw new ApiError(body?.error ?? `Error ${res.status}`, res.status);
}

/** Para respuestas sin cuerpo (204): solo verifica que haya salido bien. */
export async function expectOk(res: AnyResponse) {
  if (res.ok) return;
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  throw new ApiError(body?.error ?? `Error ${res.status}`, res.status);
}

export const errorMessage = (e: unknown) =>
  e instanceof Error ? e.message : "Ocurrió un error inesperado";
