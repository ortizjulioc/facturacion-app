import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { receiveApproval, receiveEcf } from "../lib/receiver";
import type { AppEnv } from "../types";

/** El XML del documento, venga como archivo `xml` de un formulario multipart (lo estándar) o como cuerpo XML. */
async function xmlOf(req: Request): Promise<string> {
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("multipart/form-data")) {
    const file = (await req.formData()).get("xml");
    if (typeof file === "string") return file;
    if (file) return await file.text();
    throw new HTTPException(400, { message: "Archivo no válido: falta el campo xml" });
  }
  const body = await req.text();
  if (!body.trim()) throw new HTTPException(400, { message: "Archivo no válido" });
  return body;
}

/**
 * Servicios que esta empresa expone como RECEPTOR electrónico, con las rutas estándar de «Descripción Técnica Servicios
 * Emisores Electrónicos» (no distinguen mayúsculas de minúsculas: ver `getPath` en app.ts). Son públicos: los llaman la
 * DGII y otros contribuyentes sin sesión; todo lo que reciben se valida (firma, comprador, duplicados) y la autenticación
 * por semilla, que el estándar deja como opcional, no está implementada.
 */
export const fe = new Hono<AppEnv>()
  // Recibe un e-CF y contesta, en el mismo pedido, el acuse de recibo firmado (ARECF).
  .post("/recepcion/api/ecf", async (c) => {
    const deps = c.get("deps");
    const out = await receiveEcf(
      { env: deps.env, prisma: deps.prisma, logger: deps.logger, ...(deps.fiscalFetch ? { fetch: deps.fiscalFetch } : {}) },
      await xmlOf(c.req.raw),
    );
    if ("error" in out) return c.json({ error: out.error }, out.status as 400 | 503);
    return c.body(out.xml, 200, { "content-type": "application/xml; charset=utf-8" });
  })
  // Recibe la aprobación o rechazo comercial que un cliente da a un comprobante que emitimos.
  .post("/aprobacioncomercial/api/ecf", async (c) => {
    const deps = c.get("deps");
    const out = await receiveApproval(
      { env: deps.env, prisma: deps.prisma, logger: deps.logger, ...(deps.fiscalFetch ? { fetch: deps.fiscalFetch } : {}) },
      await xmlOf(c.req.raw),
    );
    return c.json(out.body, out.status as 200 | 400);
  });
