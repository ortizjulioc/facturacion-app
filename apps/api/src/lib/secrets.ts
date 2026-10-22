import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import type { Env } from "../env";

const VERSION = Buffer.from("v1");
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Llave maestra: CERT_ENCRYPTION_KEY, o (solo desarrollo y pruebas) derivada de BETTER_AUTH_SECRET. */
function masterKey(env: Env): Buffer {
  const configured = env.CERT_ENCRYPTION_KEY;
  if (configured) return Buffer.from(configured, /^[0-9a-fA-F]{64}$/.test(configured) ? "hex" : "base64");
  return Buffer.from(hkdfSync("sha256", env.BETTER_AUTH_SECRET, "facturacion", "cert-master", 32));
}

/** Cada empresa cifra con su propia subllave: un secreto copiado a la fila de otra empresa no se abre. */
const tenantKey = (env: Env, organizationId: string) =>
  Buffer.from(hkdfSync("sha256", masterKey(env), "facturacion-cert", organizationId, 32));

/** Cifra con AES-256-GCM. Formato: `v1` · iv (12) · etiqueta (16) · texto cifrado. */
export function seal(env: Env, organizationId: string, plain: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", tenantKey(env, organizationId), iv);
  cipher.setAAD(Buffer.from(organizationId));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([VERSION, iv, cipher.getAuthTag(), body]);
}

/** Descifra lo que produjo `seal`; lanza si la llave, la empresa o los datos no coinciden. */
export function open(env: Env, organizationId: string, sealed: Uint8Array): Buffer {
  const buf = Buffer.from(sealed);
  if (buf.length < VERSION.length + IV_BYTES + TAG_BYTES || !buf.subarray(0, VERSION.length).equals(VERSION)) {
    throw new Error("Secreto con formato desconocido");
  }
  const iv = buf.subarray(VERSION.length, VERSION.length + IV_BYTES);
  const tag = buf.subarray(VERSION.length + IV_BYTES, VERSION.length + IV_BYTES + TAG_BYTES);
  const body = buf.subarray(VERSION.length + IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", tenantKey(env, organizationId), iv);
  decipher.setAAD(Buffer.from(organizationId));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}
