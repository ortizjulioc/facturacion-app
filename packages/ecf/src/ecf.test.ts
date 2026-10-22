import { describe, expect, it } from "vitest";
import { DOMParser } from "@xmldom/xmldom";
import { toCents, toMilli } from "@facturacion/core";
import {
  buildEcf,
  buildRfce,
  signRfce,
  certificateProblem,
  EcfError,
  formatDate,
  formatDateTime,
  isSummaryInvoice,
  loadCertificate,
  securityCodeOf,
  serviceUrls,
  signEcf,
  stampUrl,
  unitCode,
  verifyEcfSignature,
} from "./index";
import { sample, testP12 } from "./helpers.test-util";

const tags = (xml: string) => [...xml.matchAll(/<([A-Za-z0-9]+)>/g)].map((m) => m[1]!);
const value = (xml: string, tag: string) => new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml)?.[1];

describe("fechas en hora dominicana", () => {
  it("convierte de UTC a GMT-4", () => {
    expect(formatDate(new Date("2026-01-01T02:00:00Z"))).toBe("31-12-2025");
    expect(formatDateTime(new Date("2026-03-10T15:30:05Z"))).toBe("10-03-2026 11:30:05");
  });
});

describe("armado del XML", () => {
  it("arma una factura de consumo con el orden y los montos de la DGII", () => {
    const { xml, amounts } = buildEcf(sample("E32"));
    expect(xml.startsWith("<ECF><Encabezado><Version>1.0</Version><IdDoc>")).toBe(true);
    expect(value(xml, "TipoeCF")).toBe("32");
    expect(value(xml, "eNCF")).toBe("E320000000001");
    expect(xml).not.toContain("FechaVencimientoSecuencia");
    expect(value(xml, "FechaEmision")).toBe("10-03-2026");
    expect(value(xml, "TipoPago")).toBe("1");
    expect(xml).toContain("<FormaDePago><FormaPago>1</FormaPago><MontoPago>409.00</MontoPago></FormaDePago>");
    // 2 × 150 = 300 gravado (ITBIS 54); 1.5 × 40 − 5 = 55 exento.
    expect(amounts.taxableI1).toBe(toCents("300"));
    expect(value(xml, "MontoGravadoTotal")).toBe("300.00");
    expect(value(xml, "MontoGravadoI1")).toBe("300.00");
    expect(value(xml, "MontoExento")).toBe("55.00");
    expect(value(xml, "ITBIS1")).toBe("18");
    expect(value(xml, "TotalITBIS")).toBe("54.00");
    expect(value(xml, "TotalITBIS1")).toBe("54.00");
    expect(value(xml, "MontoTotal")).toBe("409.00");
    expect(xml).not.toContain("MontoGravadoI2");
    expect(xml).not.toContain("Comprador");
    expect(xml).not.toContain("InformacionReferencia");

    // Orden de las secciones.
    const order = ["Encabezado", "IdDoc", "Emisor", "Totales", "DetallesItems"].map((t) => xml.indexOf(`<${t}>`));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("no deja etiquetas vacías y escapa los caracteres especiales", () => {
    const { xml } = buildEcf(sample("E32"));
    expect(xml).not.toMatch(/<([A-Za-z0-9]+)><\/\1>/);
    expect(xml).not.toMatch(/<[A-Za-z0-9]+\/>/);
    expect(value(xml, "RazonSocialEmisor")).toBe("Comercial Prueba &amp; Hijos SRL");
    expect(xml).toContain("Café &quot;molido&quot; &lt;1 lb&gt;");
    // Es XML bien formado.
    const errors: string[] = [];
    new DOMParser({ onError: (_l, m) => errors.push(m) }).parseFromString(xml, "text/xml");
    expect(errors).toEqual([]);
  });

  it("detalla cada línea: código, indicador, unidad, descuento y monto", () => {
    const { xml } = buildEcf(sample("E32"));
    const items = xml.match(/<Item>.*?<\/Item>/g)!;
    expect(items).toHaveLength(2);
    expect(items[0]).toContain("<NumeroLinea>1</NumeroLinea>");
    expect(items[0]).toContain("<CodigosItem><TipoCodigo>Interna</TipoCodigo><CodigoItem>CAF-01</CodigoItem></CodigosItem>");
    expect(items[0]).toContain("<IndicadorFacturacion>1</IndicadorFacturacion>");
    expect(items[0]).toContain("<CantidadItem>2.00</CantidadItem><UnidadMedida>43</UnidadMedida><PrecioUnitarioItem>150.00</PrecioUnitarioItem>");
    expect(items[0]).toContain("<MontoItem>300.00</MontoItem>");
    expect(items[1]).toContain("<IndicadorFacturacion>4</IndicadorFacturacion>");
    expect(items[1]).toContain("<CantidadItem>1.50</CantidadItem><UnidadMedida>23</UnidadMedida>");
    expect(items[1]).toContain("<DescuentoMonto>5.00</DescuentoMonto>");
    expect(items[1]).toContain("<MontoItem>55.00</MontoItem>");
  });

  it("la factura de crédito fiscal exige comprador con RNC y vencimiento de secuencia", () => {
    expect(() => buildEcf(sample("E31"))).toThrow(/RNC/);
    const buyer = { docType: "RNC" as const, docNumber: "1-30-00000-2", name: "Cliente SRL", email: "c@example.com" };
    expect(() => buildEcf(sample("E31", { buyer, sequenceExpiry: null }))).toThrow(/vencimiento/);
    const { xml } = buildEcf(sample("E31", { buyer }));
    expect(value(xml, "FechaVencimientoSecuencia")).toBe("31-12-2027");
    expect(xml).toContain("<Comprador><RNCComprador>130000002</RNCComprador><RazonSocialComprador>Cliente SRL</RazonSocialComprador>");
  });

  it("un comprador extranjero va como IdentificadorExtranjero", () => {
    const { xml } = buildEcf(sample("E32", { buyer: { docType: "PASAPORTE", docNumber: "ab123456", name: "John" } }));
    expect(xml).toContain("<IdentificadorExtranjero>AB123456</IdentificadorExtranjero>");
    expect(xml).not.toContain("RNCComprador");
  });

  it("la factura de consumo desde RD$250,000 exige identificar al comprador", () => {
    const big = sample("E32", {
      lines: [{ name: "Equipo", quantity: toMilli("1"), unitPrice: toCents("300000"), tax: "EXENTO" }],
      payments: [{ method: "TRANSFER", amount: toCents("300000") }],
    });
    expect(() => buildEcf(big)).toThrow(/identificar al comprador/);
  });

  it("agrega la propina legal como impuesto adicional 001", () => {
    const { xml, amounts } = buildEcf(sample("E32", { propinaLegal: true, payments: [{ method: "CARD", amount: toCents("450.50") }] }));
    // Subtotal 355 → propina 35.50; total 355 + 54 + 35.50 = 444.50.
    expect(amounts.propinaLegal).toBe(toCents("35.50"));
    expect(value(xml, "MontoImpuestoAdicional")).toBe("35.50");
    expect(xml).toContain("<ImpuestosAdicionales><ImpuestoAdicional><TipoImpuesto>001</TipoImpuesto><TasaImpuestoAdicional>10</TasaImpuestoAdicional><OtrosImpuestosAdicionales>35.50</OtrosImpuestosAdicionales></ImpuestoAdicional></ImpuestosAdicionales>");
    expect(xml).toContain("<TablaImpuestoAdicional><ImpuestoAdicional><TipoImpuesto>001</TipoImpuesto></ImpuestoAdicional></TablaImpuestoAdicional>");
    expect(value(xml, "MontoTotal")).toBe("444.50");
    expect(xml).toContain("<FormaPago>3</FormaPago>");
  });

  it("los precios con ITBIS incluido se declaran con IndicadorMontoGravado 1", () => {
    const { xml, amounts } = buildEcf(
      sample("E32", { lines: [{ name: "Combo", quantity: toMilli("1"), unitPrice: toCents("118.00"), tax: "ITBIS18", priceIncludesTax: true }] }),
    );
    expect(value(xml, "IndicadorMontoGravado")).toBe("1");
    expect(amounts.taxableI1).toBe(toCents("100"));
    expect(value(xml, "MontoItem")).toBe("118.00");
    expect(value(xml, "MontoTotal")).toBe("118.00");
    expect(() =>
      buildEcf(
        sample("E32", {
          lines: [
            { name: "A", quantity: toMilli("1"), unitPrice: toCents("118"), tax: "ITBIS18", priceIncludesTax: true },
            { name: "B", quantity: toMilli("1"), unitPrice: toCents("100"), tax: "ITBIS18" },
          ],
        }),
      ),
    ).toThrow(/mezclados/);
  });

  it("rechaza cantidades con 3 decimales y e-NCF de otro tipo", () => {
    const odd = sample("E32", { lines: [{ name: "Queso", quantity: toMilli("1.255"), unitPrice: toCents("10"), tax: "ITBIS18" }] });
    expect(() => buildEcf(odd)).toThrow(EcfError);
    expect(() => buildEcf(sample("E32", { encf: "E310000000001" }))).toThrow(/no corresponde/);
  });

  it("una nota de crédito no lleva formas de pago y referencia el comprobante", () => {
    const reference = { encf: "E320000000001", issuedAt: new Date("2026-03-01T15:00:00Z"), code: 3 as const, reason: "Devolución de mercancía" };
    expect(() => buildEcf(sample("E34"))).toThrow(/modifica/);
    const { xml } = buildEcf(sample("E34", { reference }));
    expect(value(xml, "TipoeCF")).toBe("34");
    expect(value(xml, "IndicadorNotaCredito")).toBe("0");
    expect(xml).not.toContain("TablaFormasPago");
    expect(xml).not.toContain("FechaVencimientoSecuencia");
    expect(xml).toContain("<InformacionReferencia><NCFModificado>E320000000001</NCFModificado><FechaNCFModificado>01-03-2026</FechaNCFModificado><CodigoModificacion>3</CodigoModificacion><RazonModificacion>Devolución de mercancía</RazonModificacion></InformacionReferencia>");
    // Pasados 30 días el indicador cambia.
    const late = buildEcf(sample("E34", { reference: { ...reference, issuedAt: new Date("2026-01-01T15:00:00Z") } }));
    expect(value(late.xml, "IndicadorNotaCredito")).toBe("1");
  });

  it("traduce las unidades a la Tabla IV", () => {
    expect([unitCode("UND"), unitCode("kg"), unitCode("LB"), unitCode("LT"), unitCode("???"), unitCode(null)]).toEqual(["43", "21", "23", "24", "43", "43"]);
  });
});

describe("firma y código de seguridad", () => {
  const { p12, password } = testP12();
  const cert = loadCertificate(p12, password);
  const signedAt = new Date("2026-03-10T15:30:05Z");

  it("firma el comprobante y deriva el código de seguridad del SignatureValue", () => {
    const { xml } = buildEcf(sample("E32"));
    const signed = signEcf(xml, cert, signedAt);
    expect(signed.xml.startsWith('<?xml version="1.0" encoding="UTF-8"?><ECF>')).toBe(true);
    expect(signed.xml).toContain("<FechaHoraFirma>10-03-2026 11:30:05</FechaHoraFirma><Signature");
    expect(signed.signatureValue.length).toBeGreaterThan(300);
    expect(signed.securityCode).toHaveLength(6);
    expect(signed.signatureValue.startsWith(signed.securityCode)).toBe(true);
    expect(securityCodeOf(signed.xml)).toBe(signed.securityCode);
    expect(signed.xml).toContain("http://www.w3.org/2001/04/xmldsig-more#rsa-sha256");
    expect(signed.xml).toContain("http://www.w3.org/2001/04/xmlenc#sha256");
    expect(signed.xml).toContain("<X509Certificate>");
    expect(signed.xml.trimEnd().endsWith("</Signature></ECF>")).toBe(true);
  });

  it("la firma verifica y deja de verificar si se altera el documento", () => {
    const signed = signEcf(buildEcf(sample("E32")).xml, cert, signedAt);
    expect(verifyEcfSignature(signed.xml)).toBe(true);
    expect(verifyEcfSignature(signed.xml.replace("<MontoTotal>409.00", "<MontoTotal>1.00"))).toBe(false);
    expect(verifyEcfSignature(buildEcf(sample("E32")).xml)).toBe(false);
  });

  it("firmar dos veces el mismo documento da el mismo resultado (RSA PKCS#1 v1.5 es determinista)", () => {
    const { xml } = buildEcf(sample("E32"));
    expect(signEcf(xml, cert, signedAt).signatureValue).toBe(signEcf(xml, cert, signedAt).signatureValue);
  });

  it("no firma un documento ya firmado ni con un certificado vencido", () => {
    const { xml } = buildEcf(sample("E32"));
    const signed = signEcf(xml, cert, signedAt);
    expect(() => signEcf(signed.xml.replace(/^<\?xml[^>]*\?>/, ""), cert, signedAt)).toThrow(/ya está firmado/);
    const old = loadCertificate(...Object.values(testP12({ notBefore: new Date("2020-01-01"), notAfter: new Date("2021-01-01") })) as [Uint8Array, string]);
    expect(certificateProblem(old, new Date("2026-03-10"))).toMatch(/vencido/);
    expect(() => signEcf(xml, old, signedAt)).toThrow(/vencido/);
  });

  it("lee los datos del certificado y rechaza una contraseña incorrecta", () => {
    expect(cert.subject).toBe("EMISOR DE PRUEBA SRL");
    expect(cert.notAfter.getUTCFullYear()).toBe(2036);
    expect(() => loadCertificate(p12, "otra")).toThrow(/contraseña/);
    expect(() => loadCertificate(new Uint8Array([1, 2, 3]), password)).toThrow(/no es un certificado/);
  });
});

describe("resumen de factura de consumo (RFCE)", () => {
  const cert = loadCertificate(...(Object.values(testP12()) as [Uint8Array, string]));

  it("arma el resumen con encabezado, totales y el código de seguridad del e-CF, sin detalle de líneas", () => {
    const { xml, amounts } = buildRfce(
      sample("E32", { buyer: { docType: "RNC", docNumber: "130000002", name: "Cliente" }, propinaLegal: true, payments: [{ method: "CARD", amount: toCents("444.50") }] }),
      "dcp79q",
    );
    expect(xml.startsWith("<RFCE><Encabezado><Version>1.0</Version><IdDoc><TipoeCF>32</TipoeCF><eNCF>E320000000001</eNCF>")).toBe(true);
    expect(xml).toContain("<TipoIngresos>01</TipoIngresos><TipoPago>1</TipoPago><TablaFormasPago><FormaDePago><FormaPago>3</FormaPago><MontoPago>444.50</MontoPago></FormaDePago></TablaFormasPago></IdDoc>");
    expect(xml).toContain("<Emisor><RNCEmisor>101672919</RNCEmisor><RazonSocialEmisor>Comercial Prueba &amp; Hijos SRL</RazonSocialEmisor><FechaEmision>10-03-2026</FechaEmision></Emisor>");
    expect(xml).toContain("<Comprador><RNCComprador>130000002</RNCComprador><RazonSocialComprador>Cliente</RazonSocialComprador></Comprador>");
    // Los totales son los del e-CF completo (incluida la propina como impuesto adicional).
    expect(xml).toContain("<MontoGravadoTotal>300.00</MontoGravadoTotal>");
    expect(xml).toContain("<MontoExento>55.00</MontoExento>");
    expect(xml).toContain("<TotalITBIS>54.00</TotalITBIS>");
    expect(xml).toContain("<MontoImpuestoAdicional>35.50</MontoImpuestoAdicional>");
    expect(xml).toContain("<MontoTotal>444.50</MontoTotal></Totales><CodigoSeguridadeCF>dcp79q</CodigoSeguridadeCF></Encabezado></RFCE>");
    expect(amounts.total).toBe(toCents("444.50"));
    // Ni las líneas, ni los datos del emisor del e-CF completo, ni la fecha de firma van en el resumen.
    for (const absent of ["DetallesItems", "DireccionEmisor", "FechaHoraFirma", "IndicadorMontoGravado", "NombreComercial"]) expect(xml).not.toContain(absent);
    expect(xml).not.toMatch(/<([A-Za-z0-9]+)><\/\1>/);
  });

  it("solo sirve para facturas de consumo menores a RD$250,000 y exige el código de seguridad", () => {
    expect(() => buildRfce(sample("E31", { buyer: { docType: "RNC", docNumber: "130000002", name: "C" } }), "dcp79q")).toThrow(/consumo/);
    const big = sample("E32", {
      buyer: { docType: "RNC", docNumber: "130000002", name: "C" },
      lines: [{ name: "Equipo", quantity: toMilli("1"), unitPrice: toCents("300000"), tax: "EXENTO" }],
      payments: [{ method: "TRANSFER", amount: toCents("300000") }],
    });
    expect(() => buildRfce(big, "dcp79q")).toThrow(/desde RD\$250,000/);
    expect(() => buildRfce(sample("E32"), "")).toThrow(/código de seguridad/);
    expect(() => buildRfce(sample("E32"), "abc")).toThrow(/código de seguridad/);
  });

  it("se firma como el e-CF (la firma verifica) y es determinista", () => {
    const { xml } = buildRfce(sample("E32"), "dcp79q");
    const signed = signRfce(xml, cert, new Date("2026-03-10T15:30:05Z"));
    expect(signed.startsWith('<?xml version="1.0" encoding="UTF-8"?><RFCE>')).toBe(true);
    expect(signed.endsWith("</Signature></RFCE>")).toBe(true);
    expect(verifyEcfSignature(signed)).toBe(true);
    expect(verifyEcfSignature(signed.replace("<MontoTotal>409.00", "<MontoTotal>1.00"))).toBe(false);
    expect(signRfce(xml, cert, new Date("2026-03-10T15:30:05Z"))).toBe(signed); // reenviar da los mismos bytes
    expect(() => signRfce(signed.replace(/^<\?xml[^>]*\?>/, ""), cert)).toThrow(/ya está firmado/);
    expect(() => signRfce(buildEcf(sample("E32")).xml, cert)).toThrow(/no es un resumen/);
  });
});

describe("QR de consulta", () => {
  const base = {
    env: "TEST" as const,
    sellerRnc: "131880738",
    encf: "E310000000001",
    issuedAt: new Date("2026-03-10T15:30:00Z"),
    total: toCents("2.11"),
    signedAt: new Date("2026-03-10T15:30:05Z"),
    securityCode: "dcp79q",
  };

  it("arma la consulta de timbre con todos los datos", () => {
    const url = stampUrl({ ...base, type: "E31", buyerRnc: "130000002" });
    expect(url).toBe(
      "https://ecf.dgii.gov.do/testecf/consultatimbre?rncemisor=131880738&rnccomprador=130000002&encf=E310000000001&fechaemision=10-03-2026&montototal=2.11&fechafirma=10-03-2026%2011:30:05&codigoseguridad=dcp79q",
    );
  });

  it("las facturas de consumo menores a RD$250,000 usan la consulta del resumen", () => {
    expect(isSummaryInvoice("E32", toCents("6225.09"))).toBe(true);
    expect(isSummaryInvoice("E32", toCents("250000"))).toBe(false);
    expect(isSummaryInvoice("E31", toCents("10"))).toBe(false);
    const url = stampUrl({ ...base, type: "E32", encf: "E320000000064", total: toCents("6225.09"), securityCode: "uabnyh" });
    expect(url).toBe("https://fc.dgii.gov.do/testecf/consultatimbrefc?rncemisor=131880738&encf=E320000000064&montototal=6225.09&codigoseguridad=uabnyh");
  });

  it("escapa los caracteres del Base64 del código de seguridad y respeta el ambiente", () => {
    const url = stampUrl({ ...base, type: "E31", env: "PROD", securityCode: "a+/=b!" });
    expect(url).toContain("/ecf/consultatimbre?");
    expect(url).toContain("codigoseguridad=a%2B%2F%3Db%21");
    expect(serviceUrls("CERT").reception).toBe("https://ecf.dgii.gov.do/certecf/recepcion");
    expect(serviceUrls("PROD").summaryStampQuery).toBe("https://fc.dgii.gov.do/ecf/consultatimbrefc");
  });

  it("el código del QR sale de un comprobante firmado de punta a punta", () => {
    const cert = loadCertificate(...(Object.values(testP12()) as [Uint8Array, string]));
    const built = buildEcf(sample("E31", { buyer: { docType: "RNC", docNumber: "130000002", name: "Cliente" } }));
    const signed = signEcf(built.xml, cert, base.signedAt);
    const url = stampUrl({ ...base, type: "E31", total: built.amounts.total, buyerRnc: "130000002", securityCode: signed.securityCode });
    expect(url).toContain(`encf=E310000000001`);
    expect(url).toContain(`montototal=409.00`);
    expect(decodeURIComponent(url.split("codigoseguridad=")[1]!)).toBe(signed.securityCode);
  });
});
