import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { parseRanges, RELEASE_FILE, releaseContentType, type ByteRange } from "../lib/releases";

const web = (stream: Readable) => Readable.toWeb(stream) as unknown as ReadableStream;

/**
 * Versiones de la caja: el instalador, su `.blockmap` y `latest.yml`, que se leen de la carpeta `POS_RELEASES_DIR`
 * (la que deja `pnpm --filter @facturacion/pos dist`). Es público —lo consulta la caja sin sesión— pero solo sirve
 * esos tres tipos de archivo, con nombres simples. Entiende `Range` (también varios rangos a la vez, en
 * `multipart/byteranges`), que es lo que usa el actualizador para bajar solo los bloques que cambiaron.
 */
export function createUpdates(dir: string | undefined) {
  return new Hono().get("/:file", async (c) => {
    const name = c.req.param("file");
    if (!dir || !RELEASE_FILE.test(name)) throw new HTTPException(404, { message: "No encontrado" });
    const path = join(resolve(dir), name);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) throw new HTTPException(404, { message: "No encontrado" });

    const size = info.size;
    const type = releaseContentType(name);
    const etag = `W/"${size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
    const headers: Record<string, string> = {
      "accept-ranges": "bytes",
      etag,
      "last-modified": info.mtime.toUTCString(),
      // La versión vigente se consulta siempre; el instalador lleva su versión en el nombre.
      "cache-control": name.endsWith(".yml") ? "no-cache" : "public, max-age=300",
    };
    if (c.req.header("if-none-match") === etag) return new Response(null, { status: 304, headers });

    // `If-Range`: si el archivo cambió desde que empezó la descarga, no se sirve un pedazo del archivo nuevo.
    const ifRange = c.req.header("if-range");
    const ranges = ifRange && ifRange !== etag ? null : parseRanges(c.req.header("range"), size);

    if (ranges === "unsatisfiable") return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${size}` } });
    if (!ranges) return new Response(web(createReadStream(path)), { headers: { ...headers, "content-type": type, "content-length": String(size) } });
    if (ranges.length === 1) {
      const { start, end } = ranges[0]!;
      return new Response(web(createReadStream(path, { start, end })), {
        status: 206,
        headers: { ...headers, "content-type": type, "content-length": String(end - start + 1), "content-range": `bytes ${start}-${end}/${size}` },
      });
    }

    const boundary = randomBytes(12).toString("hex");
    const head = (r: ByteRange) => `\r\n--${boundary}\r\nContent-Type: ${type}\r\nContent-Range: bytes ${r.start}-${r.end}/${size}\r\n\r\n`;
    const tail = `\r\n--${boundary}--\r\n`;
    const length = ranges.reduce((n, r) => n + Buffer.byteLength(head(r)) + (r.end - r.start + 1), Buffer.byteLength(tail));
    async function* parts() {
      for (const r of ranges as ByteRange[]) {
        yield Buffer.from(head(r));
        yield* createReadStream(path, { start: r.start, end: r.end });
      }
      yield Buffer.from(tail);
    }
    return new Response(web(Readable.from(parts(), { objectMode: false })), {
      status: 206,
      headers: { ...headers, "content-type": `multipart/byteranges; boundary=${boundary}`, "content-length": String(length) },
    });
  });
}
