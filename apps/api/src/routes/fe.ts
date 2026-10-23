import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { getConnInfo } from "@hono/node-server/conninfo";
import { RateLimiter } from "../lib/rate-limit";
import { exchangeSeed, issueSeed, SeedStore, verifyToken } from "../lib/receiver-auth";
import { ANONYMOUS, isUnsafeXml, MAX_XML_BYTES, receiveApproval, receiveEcf, type Caller } from "../lib/receiver";
import type { AppEnv } from "../types";

const MINUTE = 60_000;
/** El XML (hasta MAX_XML_BYTES) más el sobre del formulario multipart. */
const MAX_BODY_BYTES = MAX_XML_BYTES + 64_000;
const ALLOWED_TYPES = ["multipart/form-data", "application/xml", "text/xml"];

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
 * DGII y otros contribuyentes sin sesión, así que van protegidos:
 *  - tamaño máximo del cuerpo y solo los tipos de contenido que el estándar usa (multipart y XML);
 *  - límite de uso por dirección y por empresa destinataria (429 con `Retry-After`);
 *  - se rechaza todo XML con DOCTYPE o ENTITY, y todo lo recibido se valida (firma, comprador, duplicados);
 *  - autenticación por semilla firmada, opcional por empresa (`requireReceiverAuth`): con ella, solo el dueño del
 *    certificado (por su RNC) puede enviar sus propios comprobantes.
 * Cada instancia de la API lleva su propio estado de límites y semillas (ver `RateLimiter`).
 */
export function createFe() {
  const limiter = new RateLimiter();
  const seeds = new SeedStore();

  /** La dirección del cliente: la del proxy de confianza si se declara, o la de la conexión. */
  const clientIp = (c: Context<AppEnv>): string => {
    if (c.get("deps").env.TRUST_PROXY === "true") {
      const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
      if (forwarded) return forwarded;
    }
    try {
      return getConnInfo(c).remote.address ?? "desconocida";
    } catch {
      return "desconocida"; // sin servidor real (pruebas)
    }
  };

  const tooMany = (c: Context<AppEnv>, retryAfter: number) => {
    c.get("deps").logger.warn({ ip: clientIp(c), path: c.req.path }, "límite de uso de /fe superado");
    return c.json({ error: "Demasiados pedidos: intenta de nuevo en un momento" }, 429, { "retry-after": String(retryAfter) });
  };

  /** Quién llama: sin `Authorization`, anónimo; con token válido, su RNC; con un token inválido o vencido, se rechaza. */
  const callerOf = (c: Context<AppEnv>): Caller | null => {
    const header = c.req.header("authorization");
    if (!header) return ANONYMOUS;
    const token = /^bearer\s+(\S+)$/i.exec(header)?.[1];
    const verified = token ? verifyToken(c.get("deps").env, token) : null;
    return verified ? { authenticated: true, rnc: verified.rnc } : null;
  };

  return new Hono<AppEnv>()
    .use("*", bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ error: "El archivo es demasiado grande" }, 413) }))
    // Un solo tipo de pedido y solo los contenidos del estándar.
    .use("*", async (c, next) => {
      if (c.req.method === "POST" && !ALLOWED_TYPES.some((t) => (c.req.header("content-type") ?? "").toLowerCase().includes(t))) {
        return c.json({ error: "Tipo de archivo no válido, favor proveer un XML" }, 415);
      }
      const { env } = c.get("deps");
      const isAuth = c.req.path.toLowerCase().startsWith("/fe/autenticacion");
      const hit = limiter.hit(`${isAuth ? "auth" : "fe"}:${clientIp(c)}`, isAuth ? env.FE_AUTH_RATE_LIMIT_PER_MINUTE : env.FE_RATE_LIMIT_PER_MINUTE, MINUTE);
      if (!hit.allowed) return tooMany(c, hit.retryAfterSeconds);
      await next();
    })

    // ───────────── Autenticación opcional por semilla ─────────────
    .get("/autenticacion/api/semilla", (c) => c.body(issueSeed(c.get("deps").env), 200, { "content-type": "application/xml; charset=utf-8" }))
    .post("/autenticacion/api/validacioncertificado", async (c) => {
      const xml = await xmlOf(c.req.raw);
      if (isUnsafeXml(xml) || Buffer.byteLength(xml) > 200_000) return c.json({ error: "Archivo no válido" }, 400);
      const out = exchangeSeed(c.get("deps").env, xml, seeds);
      if (!out.ok) return c.json({ error: out.error }, 400);
      c.get("deps").logger.info({ rnc: out.rnc }, "autenticación del receptor");
      if ((c.req.header("accept") ?? "").includes("xml") && !(c.req.header("accept") ?? "").includes("json")) {
        return c.body(
          `<?xml version="1.0" encoding="utf-8"?><RespuestaAutenticacion><token>${out.token}</token><expira>${out.expiresAt}</expira><expedido>${out.issuedAt}</expedido></RespuestaAutenticacion>`,
          200,
          { "content-type": "application/xml; charset=utf-8" },
        );
      }
      return c.json({ token: out.token, expira: out.expiresAt, expedido: out.issuedAt });
    })

    // ───────────── Recepción ─────────────
    // Recibe un e-CF y contesta, en el mismo pedido, el acuse de recibo firmado (ARECF).
    .post("/recepcion/api/ecf", async (c) => {
      const caller = callerOf(c);
      if (!caller) return c.json({ error: "Token inválido o vencido: autentícate de nuevo" }, 401);
      const xml = await xmlOf(c.req.raw);
      const rnc = /<RNCComprador>\s*([\d-]{9,13})\s*</.exec(xml)?.[1]?.replace(/-/g, "");
      if (rnc) {
        const hit = limiter.hit(`rnc:${rnc}`, c.get("deps").env.FE_RATE_LIMIT_PER_RNC_PER_MINUTE, MINUTE);
        if (!hit.allowed) return tooMany(c, hit.retryAfterSeconds);
      }
      const deps = c.get("deps");
      const out = await receiveEcf(
        { env: deps.env, prisma: deps.prisma, logger: deps.logger, ...(deps.fiscalFetch ? { fetch: deps.fiscalFetch } : {}) },
        xml,
        new Date(),
        caller,
      );
      if ("error" in out) return c.json({ error: out.error }, out.status as 400 | 401 | 403 | 503);
      return c.body(out.xml, 200, { "content-type": "application/xml; charset=utf-8" });
    })
    // Recibe la aprobación o rechazo comercial que un cliente da a un comprobante que emitimos.
    .post("/aprobacioncomercial/api/ecf", async (c) => {
      const caller = callerOf(c);
      if (!caller) return c.json({ error: "Token inválido o vencido: autentícate de nuevo" }, 401);
      const xml = await xmlOf(c.req.raw);
      const rnc = /<RNCEmisor>\s*([\d-]{9,13})\s*</.exec(xml)?.[1]?.replace(/-/g, "");
      if (rnc) {
        const hit = limiter.hit(`rnc:${rnc}`, c.get("deps").env.FE_RATE_LIMIT_PER_RNC_PER_MINUTE, MINUTE);
        if (!hit.allowed) return tooMany(c, hit.retryAfterSeconds);
      }
      const deps = c.get("deps");
      const out = await receiveApproval(
        { env: deps.env, prisma: deps.prisma, logger: deps.logger, ...(deps.fiscalFetch ? { fetch: deps.fiscalFetch } : {}) },
        xml,
        new Date(),
        caller,
      );
      return c.json(out.body, out.status as 200 | 400 | 401 | 403);
    });
}
