import { certificateProblem, EcfError, loadCertificate, type EcfCertificate } from "@facturacion/ecf";
import { getMeta, setMeta, type Db } from "./store";
import type { ApiClient } from "./api";
import { ApiError } from "./api";

/**
 * Cifra y descifra textos con el almacén seguro del sistema (en Electron, `safeStorage`: DPAPI en Windows, Keychain en
 * macOS, el llavero en Linux). `available` es `true` solo si de verdad cifra: la llave privada del certificado nunca se
 * guarda sin cifrar.
 */
export type SecretBox = {
  encrypt(plain: string): string;
  decrypt(cipher: string): string;
  available?(): boolean;
};

/** Error con un mensaje apto para mostrar al usuario. */
export class CertificateError extends Error {}

/** Datos del certificado instalado en esta caja (nada secreto). */
export type LocalCertificateInfo = { subject: string; notAfter: string; version: string; problem: string | null };

type StoredInfo = { subject: string; notAfter: string; version: string };

/** El certificado ya descifrado y leído, para no repetir el trabajo (el .p12 usa una derivación de llave lenta) en cada venta. */
const cache = new WeakMap<Db, { version: string; cert: EcfCertificate }>();

export function certificateInfo(db: Db, now: Date = new Date()): LocalCertificateInfo | null {
  const raw = getMeta(db, "cert_info");
  if (!raw) return null;
  const info = JSON.parse(raw) as StoredInfo;
  return { ...info, problem: certificateProblem({ notBefore: new Date(0), notAfter: new Date(info.notAfter), privateKeyPem: "", certificatePem: "", subject: info.subject }, now) };
}

/** Guarda el certificado cifrado. Lanza `CertificateError` si no es válido o si el equipo no tiene almacén seguro. */
export function installCertificate(db: Db, box: SecretBox, input: { p12: string; password: string; version: string }): LocalCertificateInfo {
  if (!box.available?.()) {
    throw new CertificateError("Este equipo no tiene un almacén seguro para guardar el certificado: la firma local no está disponible");
  }
  let cert: EcfCertificate;
  try {
    cert = loadCertificate(Buffer.from(input.p12, "base64"), input.password);
  } catch (e) {
    throw new CertificateError(e instanceof EcfError ? e.message : "El certificado no se pudo leer");
  }
  const problem = certificateProblem(cert);
  if (problem) throw new CertificateError(problem);

  setMeta(db, "cert_secret", box.encrypt(JSON.stringify({ p12: input.p12, password: input.password })));
  setMeta(db, "cert_info", JSON.stringify({ subject: cert.subject, notAfter: cert.notAfter.toISOString(), version: input.version } satisfies StoredInfo));
  cache.set(db, { version: input.version, cert });
  return certificateInfo(db)!;
}

export function removeCertificate(db: Db) {
  setMeta(db, "cert_secret", null);
  setMeta(db, "cert_info", null);
  cache.delete(db);
}

/** El certificado listo para firmar, o null si no hay, no se puede descifrar o venció. */
export function localCertificate(db: Db, box: SecretBox, now: Date = new Date()): EcfCertificate | null {
  const info = certificateInfo(db, now);
  if (!info || info.problem) return null;
  const hit = cache.get(db);
  if (hit && hit.version === info.version) return hit.cert;
  try {
    const { p12, password } = JSON.parse(box.decrypt(getMeta(db, "cert_secret") ?? "")) as { p12: string; password: string };
    const cert = loadCertificate(Buffer.from(p12, "base64"), password);
    cache.set(db, { version: info.version, cert });
    return cert;
  } catch {
    return null; // otro usuario del sistema o equipo: no se puede abrir; se volverá a bajar al sincronizar
  }
}

/**
 * Baja el certificado de la nube cuando cambió (o lo quita si la empresa ya no tiene uno). Solo lo entrega a una sesión
 * de administrador: con otra sesión (403) se conserva lo que haya. Devuelve un aviso para mostrar, o null.
 */
export async function pullCertificate(db: Db, api: ApiClient, box: SecretBox): Promise<string | null> {
  if (!box.available?.()) return null;
  const known = certificateInfo(db)?.version;
  let res: Awaited<ReturnType<ApiClient["certificate"]>>;
  try {
    res = await api.certificate(known);
  } catch (e) {
    if (e instanceof ApiError && e.status === 403) return null;
    throw e;
  }
  const d = res.data;
  if (d.status === "none") {
    removeCertificate(db);
    return null;
  }
  if (d.status === "unchanged") return null;
  try {
    installCertificate(db, box, { p12: d.p12, password: d.password, version: d.version });
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : "No se pudo instalar el certificado";
  }
}
