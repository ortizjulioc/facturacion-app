import { DOMParser } from "@xmldom/xmldom";
import { fromCents, normalizeDocument, toCents, type Cents } from "@facturacion/core";
import { clean, formatDateTime, leaf, node, serialize, type XmlNode } from "./format";
import { certificateProblem, signXml, verifyEcfSignature, type EcfCertificate } from "./sign";
import { EcfError } from "./types";

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>';

/** Motivos por los que un e-CF no se da por recibido (campo CodigoMotivoNoRecibido del acuse). */
export const NOT_RECEIVED_REASONS = {
  1: "Error de especificación",
  2: "Error de firma digital",
  3: "Envío duplicado",
  4: "RNC del comprador no corresponde",
} as const;
export type NotReceivedReason = keyof typeof NOT_RECEIVED_REASONS;

// ───────────── Acuse de recibo (ARECF) ─────────────

export type AcknowledgementInput = {
  /** RNC de quien emitió el e-CF y RNC de quien lo recibe (nosotros). */
  sellerRnc: string;
  buyerRnc: string;
  encf: string;
  /** null = recibido (Estado 0); con motivo = no recibido (Estado 1). */
  reason: NotReceivedReason | null;
  at: Date;
};

/**
 * Acuse de recibo, sin firmar: lo que el receptor responde, en el mismo pedido, cuando le llega un e-CF. Solo dice si
 * el comprobante llegó bien (Estado 0) o no (Estado 1 y su motivo); la conformidad comercial es otro documento.
 * Formato del ejemplo oficial de «Descripción Técnica Servicios Emisores Electrónicos»; los códigos de motivo vienen del
 * XSD, que no está disponible junto a ese documento.
 */
export function buildArecf(a: AcknowledgementInput): string {
  const root: XmlNode = {
    name: "ARECF",
    children: [
      node(
        "DetalleAcusedeRecibo",
        leaf("Version", "1.0"),
        leaf("RNCEmisor", a.sellerRnc),
        leaf("RNCComprador", a.buyerRnc),
        leaf("eNCF", a.encf),
        leaf("Estado", a.reason ? 1 : 0),
        leaf("CodigoMotivoNoRecibido", a.reason),
        leaf("FechaHoraAcuseRecibo", formatDateTime(a.at)),
      ),
    ],
  };
  return serialize(root);
}

// ───────────── Aprobación comercial (ACECF) ─────────────

export type ApprovalInput = {
  sellerRnc: string;
  buyerRnc: string;
  encf: string;
  /** Fecha de emisión del e-CF, «dd-MM-AAAA», tal como viene en el comprobante. */
  issuedOn: string;
  total: Cents;
  approved: boolean;
  /** Obligatorio si se rechaza. */
  rejectReason?: string | null;
  at: Date;
};

/**
 * Aprobación o rechazo comercial, sin firmar: la respuesta del comprador sobre su conformidad con la transacción. Se envía
 * al emisor y se copia a la DGII (que solo la recibe de e-CF que ella ya aceptó).
 */
export function buildAcecf(a: ApprovalInput): string {
  if (!a.approved && !a.rejectReason?.trim()) throw new EcfError("Indica el motivo del rechazo");
  const root: XmlNode = {
    name: "ACECF",
    children: [
      node(
        "DetalleAprobacionComercial",
        leaf("Version", "1.0"),
        leaf("RNCEmisor", a.sellerRnc),
        leaf("eNCF", a.encf),
        leaf("FechaEmision", a.issuedOn),
        leaf("MontoTotal", fromCents(a.total)),
        leaf("RNCComprador", a.buyerRnc),
        leaf("Estado", a.approved ? 1 : 2),
        a.approved ? null : leaf("DetalleMotivoRechazo", clean(a.rejectReason ?? "", 250)),
        leaf("FechaHoraAprobacionComercial", formatDateTime(a.at)),
      ),
    ],
  };
  return serialize(root);
}

/** Firma un acuse (ARECF) o una aprobación (ACECF). Es la misma firma XMLDSig de todos los documentos. */
export function signReply(xml: string, cert: EcfCertificate, root: "ARECF" | "ACECF", at: Date = new Date()): string {
  if (!xml.startsWith(`<${root}>`) || !xml.endsWith(`</${root}>`)) throw new EcfError(`El XML no es un ${root} sin firmar`);
  if (xml.includes("<Signature")) throw new EcfError("El documento ya está firmado");
  const problem = certificateProblem(cert, at);
  if (problem) throw new EcfError(problem);
  return `${XML_DECLARATION}${signXml(xml, cert)}`;
}

// ───────────── Leer lo que llega ─────────────

export type IncomingEcf = {
  /** Tipo de comprobante, «31», «33», «41»… */
  type: string;
  encf: string;
  sellerRnc: string;
  sellerName: string | null;
  buyerRnc: string | null;
  buyerName: string | null;
  /** «dd-MM-AAAA», tal como viene. */
  issuedOn: string;
  total: Cents;
  totalItbis: Cents;
  /** FechaHoraFirma, «dd-MM-AAAA HH:mm:ss». */
  signedAt: string | null;
  /** Primeros 6 caracteres del SignatureValue. */
  securityCode: string | null;
};

export type Inspection =
  | { ok: true; facts: IncomingEcf; signatureValid: boolean }
  | { ok: false; error: string; /** Lo que se alcanzó a leer, para poder contestar el acuse. */ partial: { sellerRnc: string | null; buyerRnc: string | null; encf: string | null } };

const text = (doc: ReturnType<DOMParser["parseFromString"]>, parent: string, tag: string): string | null => {
  const scope = doc.getElementsByTagName(parent)[0];
  const el = scope?.getElementsByTagName(tag)[0];
  const t = el?.textContent?.trim();
  return t ? t : null;
};

/** Lee un XML; devuelve null si ni siquiera es un documento (el lector lanza en vez de avisar). */
function parse(xml: string, errors: string[]) {
  try {
    return new DOMParser({ onError: (_l, m) => errors.push(m) }).parseFromString(xml, "text/xml");
  } catch {
    return null;
  }
}

const centsOf = (v: string | null): Cents | null => {
  if (v === null) return null;
  try {
    return toCents(v);
  } catch {
    return null;
  }
};

/**
 * Revisa un e-CF que llegó de otro contribuyente: estructura mínima (la que hace falta para registrarlo y contestar),
 * y si la firma es íntegra. No sustituye la validación contra el XSD ni la de la DGII.
 */
export function inspectIncomingEcf(xml: string): Inspection {
  const errors: string[] = [];
  const doc = parse(xml, errors);
  if (!doc) return { ok: false, error: "El archivo no es un XML válido", partial: { sellerRnc: null, buyerRnc: null, encf: null } };
  const rawRnc = (v: string | null) => v?.replace(/[\s-]/g, "") ?? null;
  const partial = {
    sellerRnc: rawRnc(text(doc, "Emisor", "RNCEmisor")),
    buyerRnc: rawRnc(text(doc, "Comprador", "RNCComprador")),
    encf: text(doc, "IdDoc", "eNCF"),
  };
  const fail = (error: string): Inspection => ({ ok: false, error, partial });

  if (errors.length > 0 || doc.documentElement?.nodeName !== "ECF") return fail("El archivo no es un e-CF (XML con raíz ECF)");
  const type = text(doc, "IdDoc", "TipoeCF");
  const encf = partial.encf;
  if (!type || !/^\d{2}$/.test(type)) return fail("Falta el tipo de comprobante");
  if (!encf || !/^E\d{12}$/.test(encf) || encf.slice(1, 3) !== type) return fail("El e-NCF no es válido");
  const sellerRnc = partial.sellerRnc;
  if (!sellerRnc || !normalizeDocument(sellerRnc.length === 11 ? "CEDULA" : "RNC", sellerRnc).ok) return fail("El RNC del emisor no es válido");
  const issuedOn = text(doc, "Emisor", "FechaEmision");
  if (!issuedOn || !/^\d{2}-\d{2}-\d{4}$/.test(issuedOn)) return fail("Falta la fecha de emisión");
  const total = centsOf(text(doc, "Totales", "MontoTotal"));
  if (total === null || total < 0n) return fail("Falta el monto total");

  const facts: IncomingEcf = {
    type,
    encf,
    sellerRnc,
    sellerName: text(doc, "Emisor", "RazonSocialEmisor"),
    buyerRnc: partial.buyerRnc,
    buyerName: text(doc, "Comprador", "RazonSocialComprador"),
    issuedOn,
    total,
    totalItbis: centsOf(text(doc, "Totales", "TotalITBIS")) ?? 0n,
    signedAt: doc.getElementsByTagName("FechaHoraFirma")[0]?.textContent?.trim() || null,
    securityCode: /<SignatureValue[^>]*>([^<]+)<\/SignatureValue>/.exec(xml)?.[1]?.replace(/\s+/g, "").slice(0, 6) ?? null,
  };
  return { ok: true, facts, signatureValid: verifyEcfSignature(xml) };
}

/** Lo que dice una aprobación comercial recibida (ACECF). */
export type IncomingApproval = {
  sellerRnc: string;
  buyerRnc: string;
  encf: string;
  issuedOn: string;
  total: Cents;
  approved: boolean;
  rejectReason: string | null;
  approvedAt: string | null;
};

export function inspectIncomingApproval(xml: string): { ok: true; facts: IncomingApproval; signatureValid: boolean } | { ok: false; error: string } {
  const errors: string[] = [];
  const doc = parse(xml, errors);
  if (!doc || errors.length > 0 || doc.documentElement?.nodeName !== "ACECF") return { ok: false, error: "El archivo no es una aprobación comercial (ACECF)" };
  const t = (tag: string) => text(doc, "DetalleAprobacionComercial", tag);
  const [sellerRnc, buyerRnc, encf, issuedOn] = [t("RNCEmisor"), t("RNCComprador"), t("eNCF"), t("FechaEmision")];
  const total = centsOf(t("MontoTotal"));
  const state = t("Estado");
  if (!sellerRnc || !buyerRnc || !encf || !issuedOn || total === null || (state !== "1" && state !== "2")) {
    return { ok: false, error: "La estructura del archivo XML no es válida" };
  }
  return {
    ok: true,
    facts: { sellerRnc, buyerRnc, encf, issuedOn, total, approved: state === "1", rejectReason: t("DetalleMotivoRechazo"), approvedAt: t("FechaHoraAprobacionComercial") },
    signatureValid: verifyEcfSignature(xml),
  };
}
