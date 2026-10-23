/** Rango de bytes de un archivo, con ambos extremos incluidos (como en `Range: bytes=a-b`). */
export type ByteRange = { start: number; end: number };

/**
 * Archivos que se publican para las cajas: el instalador (`.exe`), su `.blockmap` (para bajar solo lo que cambió) y el
 * `latest.yml` que dice cuál es la versión vigente. Nada de rutas: solo un nombre simple.
 */
export const RELEASE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.(yml|exe|blockmap)$/;

/** Más rangos que esto en un pedido se ignoran (se sirve el archivo completo, como permite el estándar). */
export const MAX_RANGES = 1000;

export function releaseContentType(name: string): string {
  return name.endsWith(".yml") ? "text/yaml; charset=utf-8" : "application/octet-stream";
}

/**
 * Interpreta un encabezado `Range` (uno o varios rangos, `a-b`, `a-` o `-n`) para un archivo de `size` bytes.
 *  - `null`: no hay rango, o está mal escrito: se ignora y se envía el archivo completo (200).
 *  - `"unsatisfiable"`: ningún rango cae dentro del archivo (416).
 *  - lista: los rangos pedidos, en el mismo orden (el actualizador los espera así), recortados al final del archivo.
 */
export function parseRanges(header: string | null | undefined, size: number): ByteRange[] | "unsatisfiable" | null {
  const m = /^bytes=(.+)$/i.exec(header?.trim() ?? "");
  if (!m) return null;
  const specs = m[1]!.split(",").map((s) => s.trim());
  if (specs.length > MAX_RANGES) return null;
  const ranges: ByteRange[] = [];
  for (const spec of specs) {
    const p = /^(\d*)-(\d*)$/.exec(spec);
    if (!p || (p[1] === "" && p[2] === "")) return null;
    if (p[1] === "") {
      // «los últimos n bytes»
      const n = Number(p[2]);
      if (n > 0 && size > 0) ranges.push({ start: Math.max(size - n, 0), end: size - 1 });
      continue;
    }
    const start = Number(p[1]);
    const end = p[2] === "" ? size - 1 : Number(p[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return null;
    if (start >= size) continue;
    ranges.push({ start, end: Math.min(end, size - 1) });
  }
  return ranges.length > 0 ? ranges : "unsatisfiable";
}
