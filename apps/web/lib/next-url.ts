/**
 * Acepta solo rutas internas ("/panel/…") como destino posterior al login, para evitar
 * redirecciones abiertas (`//otro-sitio.com`, `https://…`).
 */
export function safeNext(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  if (!v || !v.startsWith("/") || v.startsWith("//") || v.includes("\\"))
    return undefined;
  return v;
}
