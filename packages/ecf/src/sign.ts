import forge from "node-forge";
import { DOMParser } from "@xmldom/xmldom";
import { SignedXml } from "xml-crypto";
import { formatDateTime } from "./format";
import { EcfError } from "./types";

const C14N = "http://www.w3.org/TR/2001/REC-xml-c14n-20010315";
const ENVELOPED = "http://www.w3.org/2000/09/xmldsig#enveloped-signature";
const RSA_SHA256 = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";
const SHA256 = "http://www.w3.org/2001/04/xmlenc#sha256";
const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>';

/** Certificado de firma del emisor (el .p12 que emite una entidad autorizada por la DGII). */
export type EcfCertificate = {
  privateKeyPem: string;
  certificatePem: string;
  /** Nombre común del titular, para mostrar. */
  subject: string;
  notBefore: Date;
  notAfter: Date;
};

export type SignedEcf = {
  /** El e-CF completo, con FechaHoraFirma y firma, listo para enviar a la DGII. */
  xml: string;
  /** Primeros 6 caracteres del SignatureValue: va en el QR y en la representación impresa. */
  securityCode: string;
  signatureValue: string;
  /** Instante de la firma (FechaHoraFirma). */
  signedAt: Date;
};

const toBinary = (data: Uint8Array) => forge.util.createBuffer(Buffer.from(data).toString("binary")).getBytes();

/**
 * Lee un certificado .p12 / .pfx. Con una contraseña incorrecta o un archivo que no es un PKCS#12
 * lanza un `EcfError` con un mensaje apto para el usuario.
 */
export function loadCertificate(p12: Uint8Array, password: string): EcfCertificate {
  let bundle: forge.pkcs12.Pkcs12Pfx;
  try {
    bundle = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(toBinary(p12)), password);
  } catch (e) {
    const message = e instanceof Error ? e.message : "";
    if (/mac|password|decrypt/i.test(message)) throw new EcfError("La contraseña del certificado no es correcta");
    throw new EcfError("El archivo no es un certificado .p12 válido");
  }

  const shrouded = forge.pki.oids.pkcs8ShroudedKeyBag!;
  const plain = forge.pki.oids.keyBag!;
  const certBag = forge.pki.oids.certBag!;
  const keyBags = [
    ...(bundle.getBags({ bagType: shrouded })[shrouded] ?? []),
    ...(bundle.getBags({ bagType: plain })[plain] ?? []),
  ];
  const key = keyBags.find((b) => b.key)?.key;
  const certs = (bundle.getBags({ bagType: certBag })[certBag] ?? [])
    .map((b) => b.cert)
    .filter((c): c is forge.pki.Certificate => !!c);
  if (!key) throw new EcfError("El certificado no contiene una llave privada");

  // El certificado del firmante es el que corresponde a la llave (el archivo puede traer toda la cadena).
  const publicKey = forge.pki.setRsaPublicKey((key as forge.pki.rsa.PrivateKey).n, (key as forge.pki.rsa.PrivateKey).e);
  const publicPem = forge.pki.publicKeyToPem(publicKey);
  const leaf = certs.find((c) => forge.pki.publicKeyToPem(c.publicKey) === publicPem);
  if (!leaf) throw new EcfError("El certificado no contiene el certificado del firmante");

  return {
    privateKeyPem: forge.pki.privateKeyToPem(key as forge.pki.rsa.PrivateKey),
    certificatePem: forge.pki.certificateToPem(leaf),
    subject: String(leaf.subject.getField("CN")?.value ?? ""),
    notBefore: leaf.validity.notBefore,
    notAfter: leaf.validity.notAfter,
  };
}

/** `null` si el certificado sirve para firmar en `at`; si no, el motivo. */
export function certificateProblem(cert: EcfCertificate, at: Date = new Date()): string | null {
  if (at < cert.notBefore) return "El certificado digital todavía no está vigente";
  if (at > cert.notAfter) return "El certificado digital está vencido";
  return null;
}

/** Los primeros seis caracteres del SignatureValue (el «código de seguridad» del timbre). */
export function securityCodeOf(signedXml: string): string {
  const m = /<SignatureValue[^>]*>([^<]+)<\/SignatureValue>/.exec(signedXml);
  if (!m) throw new EcfError("El comprobante no tiene firma");
  return m[1]!.replace(/\s+/g, "").slice(0, 6);
}

/**
 * Firma un e-CF (`<ECF>…</ECF>` que arma `buildEcf`): agrega FechaHoraFirma y una firma XMLDSig
 * envuelta (enveloped) sobre todo el documento — RSA-SHA256, resumen SHA-256, canonicalización C14N 1.0 —
 * con el certificado del emisor en KeyInfo. La FechaHoraFirma va en hora dominicana (GMT-4).
 */
export function signEcf(xml: string, cert: EcfCertificate, signedAt: Date = new Date()): SignedEcf {
  if (!xml.startsWith("<ECF>") || !xml.endsWith("</ECF>")) throw new EcfError("El XML no es un e-CF sin firmar");
  if (xml.includes("<Signature")) throw new EcfError("El e-CF ya está firmado");
  const problem = certificateProblem(cert, signedAt);
  if (problem) throw new EcfError(problem);

  const withDate = `${xml.slice(0, -"</ECF>".length)}<FechaHoraFirma>${formatDateTime(signedAt)}</FechaHoraFirma></ECF>`;

  const base64Cert = cert.certificatePem.replace(/-----[A-Z ]+-----|\s+/g, "");
  const sig = new SignedXml({
    privateKey: cert.privateKeyPem,
    publicCert: cert.certificatePem,
    signatureAlgorithm: RSA_SHA256,
    canonicalizationAlgorithm: C14N,
    getKeyInfoContent: () => `<X509Data><X509Certificate>${base64Cert}</X509Certificate></X509Data>`,
  });
  sig.addReference({
    xpath: "/*",
    transforms: [ENVELOPED, C14N],
    digestAlgorithm: SHA256,
    isEmptyUri: true,
  });
  sig.computeSignature(withDate, { prefix: "", location: { reference: "/*", action: "append" } });

  const signed = sig.getSignedXml();
  return {
    xml: `${XML_DECLARATION}${signed}`,
    securityCode: securityCodeOf(signed),
    signatureValue: /<SignatureValue[^>]*>([^<]+)<\/SignatureValue>/.exec(signed)![1]!.replace(/\s+/g, ""),
    signedAt,
  };
}

/**
 * Comprueba la firma de un e-CF con el certificado que lleva en KeyInfo. Solo valida la integridad
 * (que nada cambió desde que se firmó): la confianza en el certificado la decide la DGII.
 */
export function verifyEcfSignature(signedXml: string): boolean {
  const doc = new DOMParser().parseFromString(signedXml, "text/xml");
  const sigNode = doc.getElementsByTagNameNS("http://www.w3.org/2000/09/xmldsig#", "Signature")[0];
  const certText = doc.getElementsByTagNameNS("http://www.w3.org/2000/09/xmldsig#", "X509Certificate")[0]?.textContent;
  if (!sigNode || !certText) return false;
  const pem = `-----BEGIN CERTIFICATE-----\n${certText.replace(/\s+/g, "").replace(/(.{64})/g, "$1\n")}\n-----END CERTIFICATE-----`;
  const verifier = new SignedXml({ publicCert: pem });
  verifier.loadSignature(sigNode as unknown as Parameters<SignedXml["loadSignature"]>[0]);
  try {
    return verifier.checkSignature(signedXml);
  } catch {
    return false;
  }
}
