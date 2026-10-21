import { generateKeyPairSync } from "node:crypto";
import forge from "node-forge";
import { toCents, toMilli, type EcfType } from "@facturacion/core";
import type { EcfInput } from "./types";

/** Genera un .p12 autofirmado de prueba (RSA 2048). */
export function testP12(opts: { password?: string; notBefore?: Date; notAfter?: Date; cn?: string } = {}) {
  const password = opts.password ?? "clave-de-prueba";
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const key = forge.pki.privateKeyFromPem(privateKey.export({ type: "pkcs8", format: "pem" }) as string);
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.setRsaPublicKey(key.n, key.e);
  cert.serialNumber = "01";
  cert.validity.notBefore = opts.notBefore ?? new Date("2026-01-01T00:00:00Z");
  cert.validity.notAfter = opts.notAfter ?? new Date("2036-01-01T00:00:00Z");
  const attrs = [{ name: "commonName", value: opts.cn ?? "EMISOR DE PRUEBA SRL" }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(key, forge.md.sha256.create());
  const asn1 = forge.pkcs12.toPkcs12Asn1(key, [cert], password, { algorithm: "3des" });
  const der = forge.asn1.toDer(asn1).getBytes();
  return { p12: new Uint8Array(Buffer.from(der, "binary")), password };
}

export const SELLER = {
  rnc: "101672919",
  legalName: "Comercial Prueba & Hijos SRL",
  tradeName: "La Esquina",
  address: "Av. Winston Churchill 100, Santo Domingo",
  municipalityCode: "010100",
  provinceCode: "010000",
  phones: ["809-555-0100"],
  email: "ventas@example.com",
};

const ENCF: Record<string, string> = { E31: "E310000000001", E32: "E320000000001", E33: "E330000000001", E34: "E340000000001" };

/** Venta típica: dos líneas con ITBIS 18 %, una exenta. */
export function sample(type: EcfType = "E32", over: Partial<EcfInput> = {}): EcfInput {
  return {
    type,
    encf: ENCF[type]!,
    issuedAt: new Date("2026-03-10T15:30:00Z"),
    seller: SELLER,
    sequenceExpiry: type === "E31" || type === "E33" ? "2027-12-31" : null,
    lines: [
      { name: 'Café "molido" <1 lb>', quantity: toMilli("2"), unitPrice: toCents("150.00"), tax: "ITBIS18", unit: "UND", code: "CAF-01" },
      { name: "Arroz", quantity: toMilli("1.5"), unitPrice: toCents("40.00"), tax: "EXENTO", unit: "LB", discount: toCents("5.00") },
    ],
    payments: [{ method: "CASH", amount: toCents("409.00") }],
    ...over,
  };
}
