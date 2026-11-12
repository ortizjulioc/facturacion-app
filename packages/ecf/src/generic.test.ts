import { describe, expect, it } from "vitest";
import { toCents, toMilli } from "@facturacion/core";
import {
  buildAcecf,
  buildAnecf,
  buildArecf,
  buildEcf,
  buildEcfFromFields,
  buildFromFields,
  buildRfce,
  buildSummaryFromFields,
  EcfError,
  fieldsFromXml,
  GENERIC_SCHEMAS,
  loadCertificate,
  signEcf,
  verifyEcfSignature,
  type FieldObject,
} from "./index";
import { SELLER, sample, testP12 } from "./helpers.test-util";
import { xsdErrors, type XsdName } from "./xsd.test-util";
import e47 from "./fixtures/set-prueba-e47.json";

const { p12, password } = testP12({ serialNumber: SELLER.rnc });
const cert = loadCertificate(p12, password);
const AT = new Date("2026-03-10T16:00:00Z");
const RNC_BUYER = { docType: "RNC" as const, docNumber: "131880681", name: "Cliente SRL", email: "c@example.com" };
const ORIGINAL = { encf: "E310000000001", issuedAt: new Date("2026-03-01T15:00:00Z") };

describe("armado genérico guiado por el XSD", () => {
  it("tiene el árbol de los 15 XSD oficiales", () => {
    expect([...GENERIC_SCHEMAS].sort()).toEqual(
      ["ACECF", "ANECF", "ARECF", "ECF-31", "ECF-32", "ECF-33", "ECF-34", "ECF-41", "ECF-43", "ECF-44", "ECF-45", "ECF-46", "ECF-47", "RFCE", "Semilla"].sort(),
    );
  });

  it("arma un E47 (pago al exterior, en dólares y con retención de ISR) con datos del set de pruebas y pasa el XSD", async () => {
    const xml = buildEcfFromFields(e47 as FieldObject);
    // Orden del XSD aunque el JSON venga en otro orden, y los repetidos como elementos hermanos.
    expect(xml).toMatch(/^<ECF><Encabezado><Version>1\.0<\/Version><IdDoc><TipoeCF>47<\/TipoeCF><eNCF>E470000000007<\/eNCF>/);
    expect(xml).toContain("<TablaTelefonoEmisor><TelefonoEmisor>809-472-7676</TelefonoEmisor><TelefonoEmisor>809-491-1918</TelefonoEmisor></TablaTelefonoEmisor>");
    expect(xml.match(/<Item>/g)).toHaveLength(3);
    expect(xml).toContain("<OtraMoneda><TipoMoneda>USD</TipoMoneda><TipoCambio>57.0000</TipoCambio>");
    const signed = signEcf(xml, cert, AT);
    expect(verifyEcfSignature(signed.xml)).toBe(true);
    expect(await xsdErrors(signed.xml, "ECF-47")).toEqual([]);
  });

  it("reproduce exactamente lo que arma el sistema (E31 a E34, resumen, anulación y respuestas)", async () => {
    const reference = { ...ORIGINAL, code: 3 as const, reason: "Corrige montos" };
    const docs: [XsdName, string][] = [
      ["ECF-31", buildEcf(sample("E31", { buyer: RNC_BUYER, propinaLegal: true, payments: undefined })).xml],
      ["ECF-32", buildEcf(sample("E32")).xml],
      ["ECF-33", buildEcf(sample("E33", { buyer: RNC_BUYER, payments: undefined, reference })).xml],
      ["ECF-34", buildEcf(sample("E34", { buyer: RNC_BUYER, payments: undefined, reference })).xml],
      ["RFCE", buildRfce(sample("E32"), "dcp79q").xml],
      ["ANECF", buildAnecf({ rnc: SELLER.rnc, at: AT, lines: [{ type: "E32", ranges: [{ from: 1n, to: 9n }, { from: 20n, to: 20n }] }] })],
      ["ARECF", buildArecf({ sellerRnc: "131880681", buyerRnc: SELLER.rnc, encf: "E310000000009", reason: 2, at: AT })],
      ["ACECF", buildAcecf({ sellerRnc: "131880681", buyerRnc: SELLER.rnc, encf: "E310000000009", issuedOn: "01-03-2026", total: toCents("10"), approved: true, at: AT })],
    ];
    for (const [schema, xml] of docs) {
      expect(buildFromFields(schema, fieldsFromXml(xml)), schema).toBe(xml);
    }
  });

  it("saca el resumen (RFCE) de los campos de la factura de consumo, igual al que arma el sistema", async () => {
    for (const input of [sample("E32"), sample("E32", { propinaLegal: true, payments: undefined })]) {
      const full = buildEcf(input).xml;
      const summary = buildSummaryFromFields(fieldsFromXml(full), "dcp79q");
      expect(summary).toBe(buildRfce(input, "dcp79q").xml);
    }
  });

  it("enumera todo lo que falta, sobra o se repite de más, con su ruta", () => {
    const fields = fieldsFromXml(buildEcf(sample("E31", { buyer: RNC_BUYER })).xml) as { ECF: FieldObject };
    const enc = fields.ECF.Encabezado as FieldObject;
    const idDoc = enc.IdDoc as FieldObject;
    delete idDoc.TipoPago;
    idDoc.Inventado = "x";
    (enc.Emisor as FieldObject).TablaTelefonoEmisor = { TelefonoEmisor: ["809-555-0001", "809-555-0002", "809-555-0003", "809-555-0004"] };
    let error: unknown;
    try {
      buildFromFields("ECF-31", fields);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(EcfError);
    const lines = (error as Error).message.split("\n");
    expect(lines).toContain("Falta «ECF.Encabezado.IdDoc.TipoPago»");
    expect(lines).toContain("Campo desconocido «ECF.Encabezado.IdDoc.Inventado» (no está en el XSD)");
    expect(lines).toContain("«ECF.Encabezado.Emisor.TablaTelefonoEmisor.TelefonoEmisor» admite hasta 3 (vinieron 4)");
  });

  it("elige el XSD por el tipo, omite lo vacío y no acepta tipos inexistentes", () => {
    expect(() => buildEcfFromFields({ Encabezado: { IdDoc: { TipoeCF: "99" } } })).toThrow(/no soportado/);
    expect(() => buildEcfFromFields({ Encabezado: {} })).toThrow(/TipoeCF/);
    const fields = fieldsFromXml(buildEcf(sample("E32")).xml) as { ECF: FieldObject };
    ((fields.ECF.Encabezado as FieldObject).Emisor as FieldObject).NombreComercial = "  ";
    const xml = buildEcfFromFields(fields);
    expect(xml).not.toContain("NombreComercial");
    // El 32 exige el área Comprador aunque no haya comprador: va vacía.
    expect(xml).toContain("<Comprador></Comprador>");
    expect(toMilli("1")).toBe(1000n);
  });
});
