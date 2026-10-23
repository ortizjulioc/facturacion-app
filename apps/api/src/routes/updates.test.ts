import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_RANGES, parseRanges, RELEASE_FILE } from "../lib/releases";
import { createUpdates } from "./updates";

// Sin base de datos: la ruta solo lee una carpeta de archivos.
describe("versiones de la caja (/updates/caja)", () => {
  let dir: string;
  const installer = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));
  const latest = "version: 0.2.0\npath: Caja-Facturacion-Setup-0.2.0.exe\n";
  const app = () => createUpdates(dir);
  const get = (path: string, headers: Record<string, string> = {}, a = app()) => a.request(path, { headers });

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "releases-"));
    await writeFile(join(dir, "latest.yml"), latest);
    await writeFile(join(dir, "Caja-Facturacion-Setup-0.2.0.exe"), installer);
    await writeFile(join(dir, "Caja-Facturacion-Setup-0.2.0.exe.blockmap"), "blockmap");
    await writeFile(join(dir, "secreto.txt"), "no se publica");
    await writeFile(join(dir, ".env"), "no se publica");
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it("sirve latest.yml sin caché, para que la caja siempre vea la versión vigente", async () => {
    const res = await get("/latest.yml");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(latest);
    expect(res.headers.get("content-type")).toContain("text/yaml");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
  });

  it("sirve el instalador completo con su tamaño", async () => {
    const res = await get("/Caja-Facturacion-Setup-0.2.0.exe");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("1000");
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(Buffer.from(await res.arrayBuffer()).equals(installer)).toBe(true);
    expect((await get("/Caja-Facturacion-Setup-0.2.0.exe.blockmap")).status).toBe(200);
  });

  it("un rango devuelve solo esos bytes (206), para reanudar descargas", async () => {
    const res = await get("/Caja-Facturacion-Setup-0.2.0.exe", { range: "bytes=100-199" });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 100-199/1000");
    expect(res.headers.get("content-length")).toBe("100");
    expect(Buffer.from(await res.arrayBuffer()).equals(installer.subarray(100, 200))).toBe(true);

    const tail = await get("/Caja-Facturacion-Setup-0.2.0.exe", { range: "bytes=-10" });
    expect(tail.headers.get("content-range")).toBe("bytes 990-999/1000");
    expect(Buffer.from(await tail.arrayBuffer()).equals(installer.subarray(990))).toBe(true);
    const open = await get("/Caja-Facturacion-Setup-0.2.0.exe", { range: "bytes=995-" });
    expect(Buffer.from(await open.arrayBuffer()).equals(installer.subarray(995))).toBe(true);
  });

  it("varios rangos a la vez salen en multipart/byteranges, que es lo que usa la actualización por diferencias", async () => {
    const res = await get("/Caja-Facturacion-Setup-0.2.0.exe", { range: "bytes=0-9, 500-519" });
    expect(res.status).toBe(206);
    const type = res.headers.get("content-type")!;
    const boundary = /boundary=([0-9a-f]+)/.exec(type)![1]!;
    const body = Buffer.from(await res.arrayBuffer());
    expect(String(body.length)).toBe(res.headers.get("content-length"));
    // Cada parte lleva su Content-Range y exactamente sus bytes.
    const first = Buffer.concat([Buffer.from(`\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\nContent-Range: bytes 0-9/1000\r\n\r\n`), installer.subarray(0, 10)]);
    const second = Buffer.concat([Buffer.from(`\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\nContent-Range: bytes 500-519/1000\r\n\r\n`), installer.subarray(500, 520)]);
    expect(body.equals(Buffer.concat([first, second, Buffer.from(`\r\n--${boundary}--\r\n`)]))).toBe(true);
  });

  it("un rango fuera del archivo da 416; uno mal escrito se ignora y se envía todo", async () => {
    const out = await get("/Caja-Facturacion-Setup-0.2.0.exe", { range: "bytes=5000-6000" });
    expect(out.status).toBe(416);
    expect(out.headers.get("content-range")).toBe("bytes */1000");
    const bad = await get("/Caja-Facturacion-Setup-0.2.0.exe", { range: "bytes=abc" });
    expect(bad.status).toBe(200);
    expect((await bad.arrayBuffer()).byteLength).toBe(1000);
  });

  it("If-Range: si el archivo cambió, no se sirve un pedazo del nuevo sino el archivo completo", async () => {
    const etag = (await get("/Caja-Facturacion-Setup-0.2.0.exe")).headers.get("etag")!;
    expect((await get("/Caja-Facturacion-Setup-0.2.0.exe", { range: "bytes=0-9", "if-range": etag })).status).toBe(206);
    expect((await get("/Caja-Facturacion-Setup-0.2.0.exe", { range: "bytes=0-9", "if-range": 'W/"viejo"' })).status).toBe(200);
  });

  it("responde 304 si la caja ya tiene esa versión del archivo", async () => {
    const etag = (await get("/latest.yml")).headers.get("etag")!;
    const res = await get("/latest.yml", { "if-none-match": etag });
    expect(res.status).toBe(304);
    expect(await res.text()).toBe("");
  });

  it("no publica nada que no sea instalador, blockmap o latest.yml, ni sale de la carpeta", async () => {
    for (const path of ["/secreto.txt", "/.env", "/no-existe.exe", "/..%2Fapp.ts", "/%2e%2e%2fsecreto.yml", "/..%5Csecreto.yml", "/a%2Fb.yml", "/latest.yml%00.txt"]) {
      expect((await get(path)).status, path).toBe(404);
    }
    expect((await get("/")).status).toBe(404);
  });

  it("sin carpeta configurada no hay versiones que ofrecer (404)", async () => {
    expect((await get("/latest.yml", {}, createUpdates(undefined))).status).toBe(404);
    expect((await get("/latest.yml", {}, createUpdates(join(dir, "no-existe")))).status).toBe(404);
  });
});

describe("lectura del encabezado Range", () => {
  it("interpreta los formatos del estándar y recorta al final del archivo", () => {
    expect(parseRanges("bytes=0-499", 1000)).toEqual([{ start: 0, end: 499 }]);
    expect(parseRanges("bytes=900-5000", 1000)).toEqual([{ start: 900, end: 999 }]);
    expect(parseRanges("bytes=500-", 1000)).toEqual([{ start: 500, end: 999 }]);
    expect(parseRanges("bytes=-100", 1000)).toEqual([{ start: 900, end: 999 }]);
    expect(parseRanges("bytes=-5000", 1000)).toEqual([{ start: 0, end: 999 }]);
    expect(parseRanges("BYTES=1-2, 5-6", 1000)).toEqual([{ start: 1, end: 2 }, { start: 5, end: 6 }]);
  });

  it("sin rango, o con uno mal escrito, devuelve null (se sirve todo)", () => {
    for (const h of [undefined, null, "", "items=0-1", "bytes=", "bytes=-", "bytes=5-2", "bytes=a-b", "bytes=1-2,x", "bytes=0-1e3"]) expect(parseRanges(h, 1000), String(h)).toBeNull();
    expect(parseRanges(`bytes=${Array.from({ length: MAX_RANGES + 1 }, (_, i) => `${i}-${i}`).join(",")}`, 5000)).toBeNull();
  });

  it("los rangos fuera del archivo se descartan; si no queda ninguno, es insatisfacible", () => {
    expect(parseRanges("bytes=2000-3000", 1000)).toBe("unsatisfiable");
    expect(parseRanges("bytes=-0", 1000)).toBe("unsatisfiable");
    expect(parseRanges("bytes=0-0", 0)).toBe("unsatisfiable");
    expect(parseRanges("bytes=0-9,2000-3000", 1000)).toEqual([{ start: 0, end: 9 }]);
  });

  it("solo se aceptan nombres simples de instalador, blockmap y latest.yml", () => {
    for (const ok of ["latest.yml", "Caja-Facturacion-Setup-0.2.0.exe", "Caja-Facturacion-Setup-0.2.0.exe.blockmap"]) expect(RELEASE_FILE.test(ok), ok).toBe(true);
    for (const bad of ["../latest.yml", "a/b.exe", "a\\b.exe", ".env", ".hidden.yml", "x.txt", "x.exe.bak", "", "x.yml\n"]) expect(RELEASE_FILE.test(bad), bad).toBe(false);
  });
});
