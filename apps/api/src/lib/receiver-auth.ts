import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { DOMParser } from "@xmldom/xmldom";
import { signerInfoOf, verifyEcfSignature } from "@facturacion/ecf";
import type { Env } from "../env";

/**
 * Autenticación opcional del receptor, con el esquema del estándar de la DGII: quien quiere enviarnos un comprobante pide
 * una semilla, la firma con su certificado digital y la cambia por un token; con ese token (`Authorization: bearer`) usa
 * los servicios. La semilla y el token no se guardan: son valores firmados con HMAC (llave derivada del secreto del
 * servidor) con su vencimiento. Lo único con estado es el registro de semillas ya usadas.
 *
 * Alcance: se comprueba que la firma de la semilla sea íntegra, que el certificado esté vigente y que lleve un RNC o
 * cédula; NO se valida la cadena de confianza del certificado (no se tienen las raíces de las entidades autorizadas).
 * La identidad que se usa es el RNC del certificado, y los servicios exigen que coincida con el emisor del comprobante.
 */

export const SEED_TTL_MS = 5 * 60_000;
export const TOKEN_TTL_MS = 60 * 60_000;

const key = (env: Env) => Buffer.from(hkdfSync("sha256", env.BETTER_AUTH_SECRET, "facturacion", "fe-auth", 32));
const mac = (env: Env, data: string) => createHmac("sha256", key(env)).update(data).digest("base64url");
const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Semillas ya cambiadas por un token: una semilla sirve una sola vez. */
export class SeedStore {
  private readonly used = new Map<string, number>();
  /** true si la semilla no se había usado (y la marca como usada hasta que venza). */
  take(value: string, expiresAt: number, now: number): boolean {
    for (const [v, exp] of this.used) if (exp <= now) this.used.delete(v);
    if (this.used.has(value)) return false;
    this.used.set(value, expiresAt);
    return true;
  }
}

const isoSeconds = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** El archivo de semilla que entrega `GET /fe/autenticacion/api/semilla`. */
export function issueSeed(env: Env, now: number = Date.now()): string {
  const body = `${randomBytes(24).toString("base64url")}.${now + SEED_TTL_MS}`;
  const valor = `${body}.${mac(env, `seed:${body}`)}`;
  return `<?xml version="1.0" encoding="utf-8"?><SemillaModel xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema"><valor>${valor}</valor><fecha>${new Date(now).toISOString()}</fecha></SemillaModel>`;
}

export type Exchange =
  | { ok: true; token: string; issuedAt: string; expiresAt: string; rnc: string | null }
  | { ok: false; error: string };

/** Cambia la semilla firmada por un token. Todo defecto se informa como un mensaje claro, sin detalles internos. */
export function exchangeSeed(env: Env, signedXml: string, seeds: SeedStore, now: number = Date.now()): Exchange {
  let valor: string | undefined;
  try {
    const doc = new DOMParser({ onError: () => undefined }).parseFromString(signedXml, "text/xml");
    if (doc.documentElement?.nodeName !== "SemillaModel") return { ok: false, error: "El archivo no es una semilla firmada" };
    valor = doc.getElementsByTagName("valor")[0]?.textContent?.trim();
  } catch {
    return { ok: false, error: "El archivo no es un XML válido" };
  }
  if (!valor) return { ok: false, error: "El archivo no es una semilla firmada" };

  const [random, exp, tag] = valor.split(".");
  const expiresAt = Number(exp);
  if (!random || !tag || !Number.isFinite(expiresAt) || !safeEqual(tag, mac(env, `seed:${random}.${exp}`))) {
    return { ok: false, error: "La semilla no fue emitida por este servicio" };
  }
  if (expiresAt < now) return { ok: false, error: "La semilla venció: pide una nueva" };
  if (!verifyEcfSignature(signedXml)) return { ok: false, error: "La firma de la semilla no es válida" };

  const signer = signerInfoOf(signedXml);
  if (!signer) return { ok: false, error: "No se pudo leer el certificado con que se firmó" };
  if (now < signer.notBefore.getTime() || now > signer.notAfter.getTime()) return { ok: false, error: "El certificado está vencido o aún no es válido" };
  if (!signer.rnc) return { ok: false, error: "El certificado no identifica un RNC, cédula o pasaporte" };
  if (!seeds.take(valor, expiresAt, now)) return { ok: false, error: "Esa semilla ya se usó: pide una nueva" };

  const exp2 = now + TOKEN_TTL_MS;
  const payload = Buffer.from(JSON.stringify({ rnc: signer.rnc, iat: now, exp: exp2 })).toString("base64url");
  return { ok: true, token: `${payload}.${mac(env, `token:${payload}`)}`, issuedAt: isoSeconds(now), expiresAt: isoSeconds(exp2), rnc: signer.rnc };
}

/** El RNC al que se le dio el token, o null si el token no es válido o venció. */
export function verifyToken(env: Env, token: string, now: number = Date.now()): { rnc: string } | null {
  const [payload, tag] = token.split(".");
  if (!payload || !tag || !safeEqual(tag, mac(env, `token:${payload}`))) return null;
  try {
    const { rnc, exp } = JSON.parse(Buffer.from(payload, "base64url").toString()) as { rnc?: string; exp?: number };
    return rnc && typeof exp === "number" && exp > now ? { rnc } : null;
  } catch {
    return null;
  }
}
