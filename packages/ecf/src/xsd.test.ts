import { describe, expect, it } from "vitest";
import { toCents, toMilli } from "@facturacion/core";
import {
  buildAcecf,
  buildAnecf,
  buildArecf,
  buildEcf,
  buildRfce,
  loadCertificate,
  signEcf,
  signReply,
  signRfce,
  type EcfBuyer,
  type EcfInput,
  type EcfLine,
} from "./index";
import { SELLER, sample, testP12 } from "./helpers.test-util";
import { xsdErrors, type XsdName } from "./xsd.test-util";

// Todo lo que se envía a la DGII (o a otro contribuyente) debe pasar el XSD oficial: en la certificación, un solo
// rechazo obliga a reiniciar el set de pruebas completo. Se valida el documento ya firmado, como sale del sistema.

const { p12, password } = testP12({ serialNumber: SELLER.rnc });
const cert = loadCertificate(p12, password);
const AT = new Date("2026-03-10T16:00:00Z");

const RNC_BUYER: EcfBuyer = {
  docType: "RNC",
  docNumber: "131880681",
  name: "Cliente Empresarial SRL",
  email: "compras@example.com",
  address: "Calle 1, Santo Domingo",
  municipalityCode: "010100",
  provinceCode: "010000",
};
const MIXED: EcfLine[] = [
  { name: "Producto 18 %", quantity: toMilli("3"), unitPrice: toCents("1000.00"), tax: "ITBIS18", unit: "UND" },
  { name: "Producto 16 %", quantity: toMilli("2"), unitPrice: toCents("500.00"), tax: "ITBIS16", unit: "UND" },
  { name: "Producto 0 %", quantity: toMilli("1"), unitPrice: toCents("100.00"), tax: "ITBIS0" },
  { name: "Servicio exento", quantity: toMilli("1"), unitPrice: toCents("250.00"), tax: "EXENTO", isService: true },
];
const ORIGINAL = { encf: "E310000000001", issuedAt: new Date("2026-03-01T15:00:00Z") };

const CASES: [string, EcfInput][] = [
  ["E31 de contado", sample("E31", { buyer: RNC_BUYER })],
  ["E31 a crédito con tasas mezcladas", sample("E31", { buyer: RNC_BUYER, lines: MIXED, payments: [], paymentDueDate: "2026-04-10" })],
  ["E31 con propina legal", sample("E31", { buyer: RNC_BUYER, propinaLegal: true, payments: undefined })],
  ["E31 con precios que incluyen ITBIS", sample("E31", { buyer: RNC_BUYER, payments: undefined, lines: MIXED.map((l) => ({ ...l, priceIncludesTax: true })) })],
  ["E32 sin comprador", sample("E32")],
  ["E32 de un emisor persona física (cédula como RNC)", sample("E32", { seller: { ...SELLER, rnc: "00112345678", legalName: "Juan Pérez" } })],
  ["E31 de un emisor persona física", sample("E31", { buyer: RNC_BUYER, seller: { ...SELLER, rnc: "00112345678", legalName: "Juan Pérez" } })],
  ["E32 con propina y tasas mezcladas", sample("E32", { lines: MIXED, propinaLegal: true, payments: undefined })],
  ["E32 desde RD$250,000 con cédula", sample("E32", { buyer: { docType: "CEDULA", docNumber: "00112345678", name: "Juan Pérez" }, lines: [{ name: "Nevera", quantity: toMilli("5"), unitPrice: toCents("70000.00"), tax: "ITBIS18", unit: "UND" }], payments: undefined })],
  ["E33 nota de débito", sample("E33", { buyer: RNC_BUYER, payments: undefined, reference: { ...ORIGINAL, code: 3, reason: "Corrige montos" } })],
  ["E34 que anula", sample("E34", { buyer: RNC_BUYER, payments: undefined, reference: { ...ORIGINAL, code: 1, reason: "Anulación" } })],
  ["E34 que solo corrige texto (código 2, montos en cero)", sample("E34", { buyer: RNC_BUYER, payments: undefined, lines: [{ name: "Corrige la dirección", quantity: toMilli("1"), unitPrice: 0n, tax: "EXENTO" }], reference: { ...ORIGINAL, code: 2, reason: "Corrige la dirección del cliente" } })],
  ["E34 parcial de una factura de consumo", sample("E34", { payments: undefined, reference: { encf: "E320000000005", issuedAt: new Date("2026-01-01T15:00:00Z"), code: 3, reason: "Devolución" } })],
];

const expectValid = async (xml: string, xsd: XsdName) => expect(await xsdErrors(xml, xsd)).toEqual([]);

describe("e-CF firmado contra el XSD oficial", () => {
  it.each(CASES)("%s", async (_name, input) => {
    const signed = signEcf(buildEcf(input).xml, cert, AT);
    await expectValid(signed.xml, `ECF-${input.type.slice(1)}` as XsdName);
  });
});

describe("resumen de factura de consumo (RFCE) contra su XSD", () => {
  const consumer = CASES.filter(([, input]) => input.type === "E32" && !input.buyer);
  it.each(consumer)("%s", async (_name, input) => {
    const signed = signEcf(buildEcf(input).xml, cert, AT);
    await expectValid(signRfce(buildRfce(input, signed.securityCode).xml, cert, AT), "RFCE");
  });
});

describe("anulación, acuse y aprobación contra sus XSD", () => {
  it("anulación de rangos (ANECF)", async () => {
    const xml = buildAnecf({
      rnc: SELLER.rnc,
      at: AT,
      lines: [
        { type: "E32", ranges: [{ from: 10n, to: 20n }, { from: 30n, to: 30n }] },
        { type: "E31", ranges: [{ from: 5n, to: 6n }] },
      ],
    });
    await expectValid(signReply(xml, cert, "ANECF", AT), "ANECF");
  });

  it.each([
    ["recibido", null],
    ["no recibido", 2],
  ] as const)("acuse de recibo (ARECF) %s", async (_name, reason) => {
    const xml = buildArecf({ sellerRnc: "131880681", buyerRnc: SELLER.rnc, encf: "E310000000009", reason, at: AT });
    await expectValid(signReply(xml, cert, "ARECF", AT), "ARECF");
  });

  it.each([true, false])("aprobación comercial (ACECF) aprobada=%s", async (approved) => {
    const xml = buildAcecf({
      sellerRnc: "131880681",
      buyerRnc: SELLER.rnc,
      encf: "E310000000009",
      issuedOn: "01-03-2026",
      total: toCents("1180.00"),
      approved,
      rejectReason: approved ? null : "Mercancía dañada",
      at: AT,
    });
    await expectValid(signReply(xml, cert, "ACECF", AT), "ACECF");
  });
});
