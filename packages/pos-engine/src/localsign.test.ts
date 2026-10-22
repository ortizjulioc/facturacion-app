import { describe, expect, it } from "vitest";
import { loadCertificate, verifyEcfSignature } from "@facturacion/ecf";
import { testP12 } from "@facturacion/ecf/testing";
import { ApiClient } from "./api";
import { getCompany } from "./catalog";
import { CertificateError, certificateInfo, installCertificate, localCertificate, pullCertificate, removeCertificate, type SecretBox } from "./certificate";
import { makeSigner } from "./localsign";
import { createRefund } from "./refunds";
import { createSale, receiptOfSale, type SaleCtx, type SaleInput } from "./sales";
import { getMeta, run, type Db } from "./store";
import { pushSales } from "./sync";
import { fakeCloud, makeDb, product, TERMINAL } from "./helpers.test-util";

/** Almacén «seguro» de prueba: no deja ver el texto a simple vista (como lo haría el del sistema). */
const secure: SecretBox = {
  available: () => true,
  encrypt: (s) => `enc:${Buffer.from(s).reverse().toString("base64")}`,
  decrypt: (s) => Buffer.from(s.slice(4), "base64").reverse().toString(),
};
const insecure: SecretBox = { encrypt: (s) => s, decrypt: (s) => s };

const NOW = new Date("2026-10-22T15:30:00Z");
const p12 = (over: Parameters<typeof testP12>[0] = {}) => {
  const { p12, password } = testP12(over);
  return { p12: Buffer.from(p12).toString("base64"), password, version: "v1" };
};

function addBlock(db: Db, type: string, from: number, to: number, expires = "2099-12-31") {
  run(db, "INSERT INTO seq_block (id, ecf_type, from_number, to_number, next_number, expires_at) VALUES (?, ?, ?, ?, ?, ?)", crypto.randomUUID(), type, from, to, from, expires);
}

/** Caja con certificado instalado, un producto de RD$118 con ITBIS incluido, un cliente con RNC y bloques E32/E31/E34. */
function tienda(opts: { cert?: boolean } = {}) {
  const p = product();
  const kg = product({ name: "Queso", unit: "LB", price: "100.00", tax: "ITBIS18", priceIncludesTax: false, allowsDecimals: true });
  const db = makeDb({
    products: [p, kg],
    customers: [{ id: crypto.randomUUID(), name: "Cliente Fiscal", documentType: "RNC", documentNumber: "131246796", email: null, phone: null, active: true }],
    block: { type: "E32", from: 1, to: 100 },
  });
  addBlock(db, "E31", 1, 50, "2027-12-31");
  addBlock(db, "E34", 1, 50);
  if (opts.cert !== false) installCertificate(db, secure, p12());
  let n = 0;
  const ctx = (extra: Partial<SaleCtx> = {}): SaleCtx => {
    const cert = localCertificate(db, secure, NOW);
    return {
      terminalId: TERMINAL,
      now: NOW,
      newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
      cashierId: "u-ana",
      cashierName: "Ana",
      ...(cert ? { sign: makeSigner(db, cert, getCompany(db)!) } : {}),
      ...extra,
    };
  };
  const sale = (c: SaleCtx, over: Partial<SaleInput> = {}) =>
    createSale(db, c, { type: "E32", lines: [{ productId: p.id, quantity: "2" }], payments: [{ method: "CASH", amount: "236.00" }], ...over });
  return { db, p, kg, ctx, sale };
}

describe("certificado en la caja", () => {
  it("se guarda cifrado, con sus datos públicos, y se puede quitar", () => {
    const { db } = tienda({ cert: false });
    const input = p12();
    const info = installCertificate(db, secure, input);
    expect(info).toMatchObject({ subject: "EMISOR DE PRUEBA SRL", version: "v1", problem: null });
    const stored = getMeta(db, "cert_secret")!;
    expect(stored.startsWith("enc:")).toBe(true);
    expect(stored).not.toContain(input.password);
    expect(JSON.stringify([getMeta(db, "cert_info"), stored])).not.toContain(input.p12.slice(0, 40));
    expect(localCertificate(db, secure, NOW)!.subject).toBe("EMISOR DE PRUEBA SRL");
    removeCertificate(db);
    expect(certificateInfo(db)).toBeNull();
    expect(localCertificate(db, secure, NOW)).toBeNull();
  });

  it("no guarda la llave privada si el sistema no puede cifrar, ni un certificado inválido o vencido", () => {
    const { db } = tienda({ cert: false });
    expect(() => installCertificate(db, insecure, p12())).toThrow(CertificateError);
    expect(() => installCertificate(db, insecure, p12())).toThrow(/almacén seguro/);
    expect(() => installCertificate(db, secure, { ...p12(), password: "otra" })).toThrow(/contraseña/);
    expect(() => installCertificate(db, secure, { p12: Buffer.from("no es un p12").toString("base64"), password: "x", version: "v" })).toThrow(CertificateError);
    expect(() => installCertificate(db, secure, p12({ notBefore: new Date("2020-01-01"), notAfter: new Date("2021-01-01") }))).toThrow(/vencido/);
    expect(getMeta(db, "cert_secret")).toBeNull();
  });

  it("un certificado que vence deja de usarse", () => {
    const { db } = tienda({ cert: false });
    installCertificate(db, secure, p12({ notAfter: new Date("2026-11-01T00:00:00Z") }));
    expect(localCertificate(db, secure, NOW)).not.toBeNull();
    const later = new Date("2026-11-02T00:00:00Z");
    expect(certificateInfo(db, later)!.problem).toMatch(/vencido/);
    expect(localCertificate(db, secure, later)).toBeNull();
  });
});

describe("venta firmada sin internet", () => {
  it("el ticket sale con el código de seguridad y el QR, y el XML guardado verifica", () => {
    const t = tienda();
    const r = t.sale(t.ctx());
    expect(r.signWarning).toBeNull();
    expect(r.securityCode).toHaveLength(6);
    expect(r.signedAt).toBe(NOW.toISOString());
    expect(r.qr).toBe(
      `https://fc.dgii.gov.do/testecf/consultatimbrefc?rncemisor=101001577&encf=E320000000001&montototal=236.00&codigoseguridad=${encodeURIComponent(r.securityCode!)}`,
    );
    const xml = (t.db.prepare("SELECT ecf_xml FROM sale WHERE id = ?").get(r.sale.id) as { ecf_xml: string }).ecf_xml;
    expect(verifyEcfSignature(xml)).toBe(true);
    expect(xml).toContain("<eNCF>E320000000001</eNCF>");
    expect(xml).toContain("<MontoTotal>236.00</MontoTotal>");
    expect(xml).toContain("<FechaHoraFirma>22-10-2026 11:30:00</FechaHoraFirma>"); // hora dominicana
    expect(xml).toContain("<CantidadItem>2.00</CantidadItem><UnidadMedida>43</UnidadMedida>");
    expect(receiptOfSale(t.db, r.sale.id)).toMatchObject({ securityCode: r.securityCode, qr: r.qr });
  });

  it("sin certificado la venta sale como siempre: sin firma ni QR", () => {
    const t = tienda({ cert: false });
    const r = t.sale(t.ctx());
    expect(r).toMatchObject({ qr: null, securityCode: null, signWarning: null });
    expect(r.sale.status).toBe("PENDING");
  });

  it("si no se puede firmar la venta se registra igual y avisa por qué", () => {
    const t = tienda();
    const r = t.sale(t.ctx(), { lines: [{ productId: t.kg.id, quantity: "1.255" }], payments: [{ method: "CASH", amount: "148.09" }] });
    expect(r.sale.encf).toBe("E320000000001");
    expect(r.qr).toBeNull();
    expect(r.signWarning).toMatch(/2 decimales/);
    expect(receiptOfSale(t.db, r.sale.id)!.sale.status).toBe("PENDING");
  });

  it("un crédito fiscal lleva el comprador y el vencimiento del bloque", () => {
    const t = tienda();
    const customer = (t.db.prepare("SELECT id FROM customer LIMIT 1").get() as { id: string }).id;
    const r = t.sale(t.ctx(), { type: "E31", customerId: customer });
    const xml = (t.db.prepare("SELECT ecf_xml FROM sale WHERE id = ?").get(r.sale.id) as { ecf_xml: string }).ecf_xml;
    expect(xml).toContain("<FechaVencimientoSecuencia>31-12-2027</FechaVencimientoSecuencia>");
    expect(xml).toContain("<RNCComprador>131246796</RNCComprador>");
    expect(r.qr).toContain("https://ecf.dgii.gov.do/testecf/consultatimbre?rncemisor=101001577&rnccomprador=131246796&encf=E310000000001");
  });

  it("la devolución también se firma, con referencia a la venta original", () => {
    const t = tienda();
    const original = t.sale(t.ctx());
    const refund = createRefund(t.db, t.ctx(), { saleId: original.sale.id, method: "CASH" });
    expect(refund.sale.type).toBe("E34");
    expect(refund.signWarning).toBeNull();
    const xml = (t.db.prepare("SELECT ecf_xml FROM sale WHERE id = ?").get(refund.sale.id) as { ecf_xml: string }).ecf_xml;
    expect(xml).toContain("<TipoeCF>34</TipoeCF>");
    expect(xml).toContain("<NCFModificado>E320000000001</NCFModificado>");
    expect(xml).toContain("<CodigoModificacion>1</CodigoModificacion>"); // devolución completa: anula
    expect(xml).not.toContain("TablaFormasPago");
    expect(refund.qr).toContain("encf=E340000000001");
  });

  it("la venta sube con el e-CF que se firmó en la caja, y la nube confirma el mismo código", async () => {
    const t = tienda();
    const r = t.sale(t.ctx());
    const bodies: { ecf?: { xml: string; securityCode: string; signedAt: string } }[] = [];
    const { fetch } = fakeCloud({
      "POST /v1/sync/sales": ({ body }) => {
        bodies.push(body as (typeof bodies)[number]);
        return Response.json({ data: { id: "r1", encf: "E320000000001", duplicate: false, ecf: { securityCode: r.securityCode, signedAt: r.signedAt, qrUrl: r.qr } } }, { status: 201 });
      },
    });
    await pushSales(t.db, new ApiClient("https://api.test", { fetch }), NOW);
    const stored = (t.db.prepare("SELECT ecf_xml FROM sale WHERE id = ?").get(r.sale.id) as { ecf_xml: string }).ecf_xml;
    expect(bodies[0]!.ecf).toEqual({ xml: stored, securityCode: r.securityCode, signedAt: NOW.toISOString() });
    expect(receiptOfSale(t.db, r.sale.id)).toMatchObject({ securityCode: r.securityCode, qr: r.qr });

    // Sin firma local no se manda `ecf`.
    const plain = tienda({ cert: false });
    plain.sale(plain.ctx());
    const seen: unknown[] = [];
    const cloud2 = fakeCloud({ "POST /v1/sync/sales": ({ body }) => (seen.push(body), Response.json({ data: { id: "r", encf: "E320000000001", duplicate: false } }, { status: 201 })) });
    await pushSales(plain.db, new ApiClient("https://api.test", { fetch: cloud2.fetch }), NOW);
    expect(seen[0]).not.toHaveProperty("ecf");
  });
});

describe("bajar el certificado de la nube", () => {
  const updated = (v: string, over: { p12?: string; password?: string } = {}) => {
    const c = p12();
    return Response.json({ data: { status: "updated", version: v, p12: over.p12 ?? c.p12, password: over.password ?? c.password, subject: "X", notAfter: "2030-01-01T00:00:00Z" } });
  };

  it("instala lo nuevo, ignora lo que no cambió, y quita el certificado si la empresa ya no tiene", async () => {
    const { db } = tienda({ cert: false });
    const queries: (string | null)[] = [];
    let mode: "updated" | "unchanged" | "none" | "forbidden" = "updated";
    const { fetch } = fakeCloud({
      "GET /v1/sync/certificate": ({ url }) => {
        queries.push(url.searchParams.get("version"));
        if (mode === "updated") return updated("2026-10-22T10:00:00.000Z");
        if (mode === "unchanged") return Response.json({ data: { status: "unchanged", version: "2026-10-22T10:00:00.000Z" } });
        if (mode === "none") return Response.json({ data: { status: "none" } });
        return Response.json({ error: "Solo un administrador" }, { status: 403 });
      },
    });
    const api = new ApiClient("https://api.test", { fetch });
    expect(await pullCertificate(db, api, secure)).toBeNull();
    expect(certificateInfo(db)).toMatchObject({ subject: "EMISOR DE PRUEBA SRL", version: "2026-10-22T10:00:00.000Z" });

    mode = "unchanged";
    await pullCertificate(db, api, secure);
    expect(queries).toEqual([null, "2026-10-22T10:00:00.000Z"]); // la segunda vez dice qué versión tiene

    mode = "forbidden"; // una sesión que no es de administrador no cambia nada
    await pullCertificate(db, api, secure);
    expect(certificateInfo(db)).not.toBeNull();

    mode = "none";
    await pullCertificate(db, api, secure);
    expect(certificateInfo(db)).toBeNull();
  });

  it("avisa si no pudo instalarlo y no pide nada si el equipo no puede cifrar", async () => {
    const { db } = tienda({ cert: false });
    const { fetch, calls } = fakeCloud({ "GET /v1/sync/certificate": () => updated("v9", { password: "mala" }) });
    const api = new ApiClient("https://api.test", { fetch });
    expect(await pullCertificate(db, api, secure)).toMatch(/contraseña/);
    expect(certificateInfo(db)).toBeNull();
    const before = calls.length;
    expect(await pullCertificate(db, api, insecure)).toBeNull();
    expect(calls).toHaveLength(before);
    // Un error de red se propaga: la sincronización lo trata como «sin conexión».
    const down = new ApiClient("https://api.test", { fetch: async () => { throw new TypeError("fetch failed"); } });
    await expect(pullCertificate(db, down, secure)).rejects.toMatchObject({ name: "NetworkError" });
  });

  it("la firma local usa lo que bajó la nube (cadena completa)", async () => {
    const { db, sale, ctx } = tienda({ cert: false });
    const c = p12();
    const { fetch } = fakeCloud({ "GET /v1/sync/certificate": () => Response.json({ data: { status: "updated", ...c, version: "v2", subject: "X", notAfter: "2030-01-01T00:00:00Z" } }) });
    await pullCertificate(db, new ApiClient("https://api.test", { fetch }), secure);
    const r = sale(ctx());
    expect(r.securityCode).toHaveLength(6);
    expect(loadCertificate(Buffer.from(c.p12, "base64"), c.password).subject).toBe("EMISOR DE PRUEBA SRL");
  });
});
