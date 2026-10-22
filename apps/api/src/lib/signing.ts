import { HTTPException } from "hono/http-exception";
import { fromCents, parseEncf, type EcfType, type ModificationCode } from "@facturacion/core";
import {
  buildEcf,
  buildRfce,
  certificateBase64,
  formatDateTime,
  readSignedEcf,
  securityCodeOf,
  sellerOf,
  signerCertificateOf,
  verifyEcfSignature,
  certificateProblem,
  EcfError,
  loadCertificate,
  signEcf,
  signRfce,
  type EcfCertificate,
  type EcfInput,
} from "@facturacion/ecf";
import type { Prisma } from "@facturacion/db";
import type { Env } from "../env";
import { asSalesType, FULL } from "./documents";
import { open, seal } from "./secrets";
import type { TenantTx } from "../types";

type DocumentFull = Prisma.DocumentGetPayload<{ include: typeof FULL }>;
type Profile = Prisma.CompanyProfileGetPayload<object>;

const unprocessable = (message: string) => new HTTPException(422, { message });

// ───────────── Certificado de la empresa ─────────────

/** Datos públicos del certificado (el archivo y la contraseña nunca salen de la API). */
export type CertificateInfo = { subject: string; notBefore: Date; notAfter: Date; uploadedAt: Date; problem: string | null };

/** Cache del certificado ya descifrado y leído, por fila y versión: evita repetir el PBKDF2 del .p12 en cada venta. */
const cache = new Map<string, EcfCertificate>();

/** Valida y guarda (cifrado) el .p12 de la empresa; reemplaza al anterior. */
export async function saveCertificate(
  tx: TenantTx,
  env: Env,
  params: { organizationId: string; userId: string; p12: Uint8Array; password: string },
): Promise<CertificateInfo> {
  const { organizationId, userId, p12, password } = params;
  let cert: EcfCertificate;
  try {
    cert = loadCertificate(p12, password);
  } catch (e) {
    if (e instanceof EcfError) throw unprocessable(e.message);
    throw e;
  }
  const problem = certificateProblem(cert);
  if (problem) throw unprocessable(problem);

  const secret = seal(env, organizationId, Buffer.from(JSON.stringify({ p12: Buffer.from(p12).toString("base64"), password })));
  const values = { secret: new Uint8Array(secret), subject: cert.subject, notBefore: cert.notBefore, notAfter: cert.notAfter, uploadedById: userId };
  const row = await tx.companyCertificate.upsert({
    where: { organizationId },
    create: { ...values, organizationId },
    update: values,
  });
  return infoOf(row, cert);
}

function infoOf(row: { subject: string; notBefore: Date; notAfter: Date; updatedAt: Date }, cert?: EcfCertificate): CertificateInfo {
  return {
    subject: row.subject,
    notBefore: row.notBefore,
    notAfter: row.notAfter,
    uploadedAt: row.updatedAt,
    problem: certificateProblem(cert ?? { ...row, privateKeyPem: "", certificatePem: "" }),
  };
}

/** El .p12 y su contraseña en claro, SOLO para entregarlos a una caja de la empresa (ver `GET /v1/sync/certificate`). */
export async function readCertificateFile(tx: TenantTx, env: Env, organizationId: string) {
  const row = await tx.companyCertificate.findFirstOrThrow();
  const { p12, password } = JSON.parse(open(env, organizationId, row.secret).toString("utf8")) as { p12: string; password: string };
  return { p12, password, subject: row.subject, notAfter: row.notAfter.toISOString() };
}

export async function certificateInfo(tx: TenantTx): Promise<CertificateInfo | null> {
  const row = await tx.companyCertificate.findFirst({
    select: { subject: true, notBefore: true, notAfter: true, updatedAt: true },
  });
  return row ? infoOf(row) : null;
}

/** El certificado listo para firmar, o null si la empresa no ha subido uno. */
export async function loadSigner(tx: TenantTx, env: Env, organizationId: string): Promise<EcfCertificate | null> {
  const row = await tx.companyCertificate.findFirst();
  if (!row) return null;
  const key = `${row.id}:${row.updatedAt.getTime()}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let cert: EcfCertificate;
  try {
    const { p12, password } = JSON.parse(open(env, organizationId, row.secret).toString("utf8")) as { p12: string; password: string };
    cert = loadCertificate(Buffer.from(p12, "base64"), password);
  } catch {
    throw new HTTPException(500, { message: "No se pudo leer el certificado digital guardado; vuelve a subirlo" });
  }
  if (cache.size > 200) cache.clear();
  cache.set(key, cert);
  return cert;
}

// ───────────── Del comprobante al e-CF ─────────────

/** Vencimiento de la secuencia a la que pertenece el número (AAAA-MM-DD). */
async function sequenceExpiry(tx: TenantTx, encf: string): Promise<string | null> {
  const parsed = parseEncf(encf);
  if (!parsed) return null;
  const seq = await tx.sequence.findFirst({
    where: { ecfType: parsed.type, fromNumber: { lte: parsed.sequence }, toNumber: { gte: parsed.sequence } },
    select: { expiresAt: true },
  });
  return seq ? seq.expiresAt.toISOString().slice(0, 10) : null;
}

async function ecfInputFor(tx: TenantTx, doc: DocumentFull, profile: Profile): Promise<EcfInput> {
  const type: EcfType = asSalesType(doc.type);
  if (!doc.encf || !doc.issuedAt) throw new EcfError("El comprobante aún no tiene e-NCF");

  let reference: EcfInput["reference"] = null;
  if (doc.referencedDocumentId) {
    const original = await tx.document.findFirst({ where: { id: doc.referencedDocumentId } });
    if (original?.encf && original.issuedAt) {
      reference = { encf: original.encf, issuedAt: original.issuedAt, code: (doc.modificationCode ?? 3) as ModificationCode, reason: doc.notes };
    }
  }

  return {
    type,
    encf: doc.encf,
    sequenceExpiry: type === "E31" || type === "E33" ? await sequenceExpiry(tx, doc.encf) : null,
    issuedAt: doc.issuedAt,
    seller: sellerOf(profile),
    buyer:
      doc.buyerDocType && doc.buyerDocNumber
        ? { docType: doc.buyerDocType, docNumber: doc.buyerDocNumber, name: doc.buyerName }
        : null,
    lines: doc.lines.map((l) => ({
      name: l.name,
      description: l.description,
      quantity: l.quantity,
      unit: l.unit,
      unitPrice: l.unitPrice,
      priceIncludesTax: l.priceIncludesTax,
      tax: l.tax,
      discount: l.discount,
    })),
    propinaLegal: doc.propinaLegal,
    payments: doc.payments.map((p) => ({ method: p.method, amount: p.amount })),
    reference,
  };
}

/** Firma que trae una venta hecha en la caja sin conexión. */
export type LocalSignature = { xml: string; securityCode: string; signedAt: Date };

/**
 * Acepta el e-CF que la caja firmó localmente (la representación impresa ya lleva su código de seguridad, así que la
 * nube tiene que guardar ESE XML y no firmar otro). Se comprueba que sea íntegro, que sea de esta venta y que lo haya
 * firmado el certificado de la empresa. Devuelve la firma lista para guardar, o el motivo por el que no se acepta.
 */
export async function acceptLocalSignature(
  tx: TenantTx,
  env: Env,
  organizationId: string,
  doc: { type: string; encf: string; total: bigint },
  profile: Pick<Profile, "rnc">,
  local: LocalSignature,
): Promise<{ ok: true; signature: Signature } | { ok: false; reason: string }> {
  const cert = await loadSigner(tx, env, organizationId);
  if (!cert) return { ok: false, reason: "la empresa no tiene un certificado cargado en la nube" };
  const facts = readSignedEcf(local.xml);
  if (facts.root !== "ECF") return { ok: false, reason: "el XML no es un e-CF" };
  if (!verifyEcfSignature(local.xml)) return { ok: false, reason: "la firma no es válida" };
  if (signerCertificateOf(local.xml) !== certificateBase64(cert)) return { ok: false, reason: "lo firmó otro certificado" };
  if (facts.type !== doc.type.slice(1) || facts.encf !== doc.encf) return { ok: false, reason: "no corresponde al e-NCF de la venta" };
  if (facts.total !== fromCents(doc.total)) return { ok: false, reason: "el monto no coincide con el de la venta" };
  if (facts.rnc !== profile.rnc) return { ok: false, reason: "el RNC del emisor no coincide" };
  if (securityCodeOf(local.xml) !== local.securityCode) return { ok: false, reason: "el código de seguridad no corresponde a la firma" };
  if (facts.signedAt !== formatDateTime(local.signedAt)) return { ok: false, reason: "la fecha de firma no coincide" };
  return { ok: true, signature: { ecfXml: local.xml, securityCode: local.securityCode, signedAt: local.signedAt } };
}

export type Signature = { ecfXml: string; securityCode: string; signedAt: Date };

/**
 * Firma un comprobante que ya tiene e-NCF y fecha. Devuelve null cuando no se puede firmar por una
 * condición normal (la empresa no ha subido su certificado, o el comprobante es en dólares, que aún no se arma);
 * un dato que impide armar el e-CF (cantidad con 3 decimales, comprador sin RNC…) lanza 422.
 */
export async function signDocumentData(
  tx: TenantTx,
  env: Env,
  organizationId: string,
  doc: DocumentFull,
  profile: Profile,
): Promise<Signature | null> {
  if (doc.currency !== "DOP") return null;
  const cert = await loadSigner(tx, env, organizationId);
  if (!cert) return null;
  try {
    const built = buildEcf(await ecfInputFor(tx, doc, profile));
    if (built.amounts.total !== doc.total) {
      throw new EcfError("Los montos del e-CF no coinciden con los del comprobante");
    }
    const signed = signEcf(built.xml, cert);
    return { ecfXml: signed.xml, securityCode: signed.securityCode, signedAt: signed.signedAt };
  } catch (e) {
    if (e instanceof EcfError) throw unprocessable(`No se pudo firmar el e-CF: ${e.message}`);
    throw e;
  }
}

/**
 * XML firmado del resumen (RFCE) de una factura de consumo menor a RD$250,000. Lleva el código de seguridad de la firma
 * del e-CF completo, así que el comprobante tiene que estar firmado. Es determinista: reenviarlo da los mismos bytes.
 */
export async function buildSummaryXml(tx: TenantTx, doc: DocumentFull, profile: Profile, cert: EcfCertificate): Promise<string> {
  try {
    if (!doc.securityCode) throw new EcfError("El comprobante no está firmado");
    const built = buildRfce(await ecfInputFor(tx, doc, profile), doc.securityCode);
    if (built.amounts.total !== doc.total) throw new EcfError("Los montos del resumen no coinciden con los del comprobante");
    return signRfce(built.xml, cert);
  } catch (e) {
    if (e instanceof EcfError) throw unprocessable(`No se pudo armar el resumen: ${e.message}`);
    throw e;
  }
}

/** Firma un comprobante ya emitido que quedó sin firma (p. ej. la venta de una caja sin conexión). */
export async function signIssued(tx: TenantTx, env: Env, organizationId: string, id: string): Promise<DocumentFull> {
  const doc = await tx.document.findFirst({ where: { id }, include: FULL });
  if (!doc) throw new HTTPException(404, { message: "Comprobante no encontrado" });
  if (doc.status === "DRAFT") throw new HTTPException(409, { message: "El comprobante aún no está emitido" });
  if (doc.signedAt) throw new HTTPException(409, { message: "El comprobante ya está firmado" });
  const profile = await tx.companyProfile.findFirst();
  if (!profile) throw unprocessable("Registra los datos fiscales de la empresa");
  if (doc.currency !== "DOP") throw unprocessable("La firma de comprobantes en dólares aún no está disponible");
  if (!(await loadSigner(tx, env, organizationId))) {
    throw unprocessable("Sube el certificado digital de la empresa para poder firmar");
  }
  const sig = await signDocumentData(tx, env, organizationId, doc, profile);
  return tx.document.update({ where: { id }, data: sig!, include: FULL });
}

