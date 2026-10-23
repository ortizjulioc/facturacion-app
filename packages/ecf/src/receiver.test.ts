import { describe, expect, it } from "vitest";
import { toCents } from "@facturacion/core";
import {
  buildAcecf,
  buildArecf,
  buildEcf,
  DgiiClient,
  FiscalError,
  inspectIncomingApproval,
  inspectIncomingEcf,
  loadCertificate,
  PeerClient,
  peerEndpoint,
  signEcf,
  signReply,
  verifyEcfSignature,
  type FetchLike,
} from "./index";
import { sample, testP12 } from "./helpers.test-util";

const cert = loadCertificate(...(Object.values(testP12()) as [Uint8Array, string]));
const AT = new Date("2026-10-22T15:30:05Z");

/** Un e-CF de crédito fiscal de un proveedor (RNC 101672919) para nuestra empresa (RNC 130000002), ya firmado. */
function supplierInvoice(over: Parameters<typeof sample>[1] = {}) {
  const input = sample("E31", { buyer: { docType: "RNC", docNumber: "130000002", name: "Mi Empresa SRL" }, ...over });
  const built = buildEcf(input);
  return { xml: signEcf(built.xml, cert, AT).xml, total: built.amounts.total };
}

describe("acuse de recibo (ARECF)", () => {
  it("arma el acuse de un e-CF recibido, sin motivo, y se firma", () => {
    const xml = buildArecf({ sellerRnc: "101672919", buyerRnc: "130000002", encf: "E310000000001", reason: null, at: AT });
    expect(xml).toBe(
      "<ARECF><DetalleAcusedeRecibo><Version>1.0</Version><RNCEmisor>101672919</RNCEmisor><RNCComprador>130000002</RNCComprador><eNCF>E310000000001</eNCF><Estado>0</Estado><FechaHoraAcuseRecibo>22-10-2026 11:30:05</FechaHoraAcuseRecibo></DetalleAcusedeRecibo></ARECF>",
    );
    const signed = signReply(xml, cert, "ARECF", AT);
    expect(signed.startsWith('<?xml version="1.0" encoding="UTF-8"?><ARECF>')).toBe(true);
    expect(verifyEcfSignature(signed)).toBe(true);
  });

  it("un e-CF no recibido lleva Estado 1 y el código del motivo", () => {
    const xml = buildArecf({ sellerRnc: "101672919", buyerRnc: "130000002", encf: "E310000000001", reason: 3, at: AT });
    expect(xml).toContain("<Estado>1</Estado><CodigoMotivoNoRecibido>3</CodigoMotivoNoRecibido>");
  });

  it("no firma lo que no es lo que dice ni lo que ya está firmado", () => {
    const xml = buildArecf({ sellerRnc: "1", buyerRnc: "2", encf: "E310000000001", reason: null, at: AT });
    const signed = signReply(xml, cert, "ARECF", AT);
    expect(() => signReply(xml, cert, "ACECF", AT)).toThrow(/ACECF/);
    expect(() => signReply(signed.replace(/^<\?xml[^>]*\?>/, ""), cert, "ARECF", AT)).toThrow(/ya está firmado/);
  });
});

describe("aprobación comercial (ACECF)", () => {
  const base = { sellerRnc: "101672919", buyerRnc: "130000002", encf: "E310000000001", issuedOn: "10-03-2026", total: toCents("409.00"), at: AT };

  it("arma la aprobación con los datos del e-CF y el estado 1", () => {
    const xml = buildAcecf({ ...base, approved: true });
    expect(xml).toBe(
      "<ACECF><DetalleAprobacionComercial><Version>1.0</Version><RNCEmisor>101672919</RNCEmisor><eNCF>E310000000001</eNCF><FechaEmision>10-03-2026</FechaEmision><MontoTotal>409.00</MontoTotal><RNCComprador>130000002</RNCComprador><Estado>1</Estado><FechaHoraAprobacionComercial>22-10-2026 11:30:05</FechaHoraAprobacionComercial></DetalleAprobacionComercial></ACECF>",
    );
  });

  it("un rechazo exige el motivo, que va en DetalleMotivoRechazo", () => {
    expect(() => buildAcecf({ ...base, approved: false })).toThrow(/motivo/);
    expect(() => buildAcecf({ ...base, approved: false, rejectReason: "  " })).toThrow(/motivo/);
    const xml = buildAcecf({ ...base, approved: false, rejectReason: 'Mercancía "dañada" & incompleta' });
    expect(xml).toContain("<Estado>2</Estado><DetalleMotivoRechazo>Mercancía &quot;dañada&quot; &amp; incompleta</DetalleMotivoRechazo>");
  });

  it("se firma, y quien la recibe la lee de vuelta", () => {
    const signed = signReply(buildAcecf({ ...base, approved: false, rejectReason: "Precio distinto" }), cert, "ACECF", AT);
    const r = inspectIncomingApproval(signed);
    expect(r).toMatchObject({ ok: true, signatureValid: true });
    if (r.ok) expect(r.facts).toEqual({ sellerRnc: "101672919", buyerRnc: "130000002", encf: "E310000000001", issuedOn: "10-03-2026", total: toCents("409.00"), approved: false, rejectReason: "Precio distinto", approvedAt: "22-10-2026 11:30:05" });
    expect(inspectIncomingApproval(signed.replace("<MontoTotal>409.00", "<MontoTotal>1.00"))).toMatchObject({ ok: true, signatureValid: false });
    expect(inspectIncomingApproval("<ECF/>")).toMatchObject({ ok: false });
    expect(inspectIncomingApproval("<ACECF><DetalleAprobacionComercial><Version>1.0</Version></DetalleAprobacionComercial></ACECF>")).toMatchObject({ ok: false, error: expect.stringMatching(/estructura/) });
  });
});

describe("e-CF recibido de un proveedor", () => {
  it("lee los datos del comprobante y comprueba la firma", () => {
    const { xml, total } = supplierInvoice();
    const r = inspectIncomingEcf(xml);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.signatureValid).toBe(true);
    expect(r.facts).toMatchObject({
      type: "31",
      encf: "E310000000001",
      sellerRnc: "101672919",
      sellerName: "Comercial Prueba & Hijos SRL",
      buyerRnc: "130000002",
      buyerName: "Mi Empresa SRL",
      issuedOn: "10-03-2026",
      total,
      totalItbis: toCents("54.00"),
      signedAt: "22-10-2026 11:30:05",
    });
    expect(r.facts.securityCode).toHaveLength(6);
  });

  it("detecta un comprobante alterado después de firmarlo, o sin firma", () => {
    const { xml } = supplierInvoice();
    expect(inspectIncomingEcf(xml.replace("<MontoTotal>409.00", "<MontoTotal>1.00"))).toMatchObject({ ok: true, signatureValid: false });
    expect(inspectIncomingEcf(buildEcf(sample("E31", { buyer: { docType: "RNC", docNumber: "130000002", name: "X" } })).xml)).toMatchObject({ ok: true, signatureValid: false });
  });

  it("no acepta lo que no es un e-CF, y devuelve lo que alcanzó a leer para contestar el acuse", () => {
    expect(inspectIncomingEcf("esto no es xml")).toMatchObject({ ok: false });
    expect(inspectIncomingEcf("<Otro/>")).toMatchObject({ ok: false, error: expect.stringMatching(/no es un e-CF/) });
    const broken = "<ECF><Encabezado><IdDoc><TipoeCF>31</TipoeCF><eNCF>E310000000001</eNCF></IdDoc><Emisor><RNCEmisor>101672919</RNCEmisor></Emisor><Comprador><RNCComprador>1-30-00000-2</RNCComprador></Comprador></Encabezado></ECF>";
    const r = inspectIncomingEcf(broken);
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/fecha de emisión/), partial: { sellerRnc: "101672919", buyerRnc: "130000002", encf: "E310000000001" } });
    // Un e-NCF de otro tipo que el declarado.
    expect(inspectIncomingEcf(supplierInvoice().xml.replace("<TipoeCF>31</TipoeCF>", "<TipoeCF>34</TipoeCF>"))).toMatchObject({ ok: false, error: expect.stringMatching(/e-NCF/) });
  });
});

describe("directorio y aprobación en la DGII", () => {
  const seed = `<?xml version="1.0"?><SemillaModel><valor>abc</valor><fecha>2026-10-22T08:00:00-04:00</fecha></SemillaModel>`;
  const dgii = (extra: Record<string, (init?: RequestInit) => Response | Promise<Response>>) => {
    const calls: { method: string; url: string }[] = [];
    const fetch: FetchLike = async (input, init) => {
      const u = new URL(input);
      calls.push({ method: init?.method ?? "GET", url: u.pathname + u.search });
      if (u.pathname.endsWith("/autenticacion/api/autenticacion/semilla")) return new Response(seed);
      if (u.pathname.endsWith("/autenticacion/api/autenticacion/validarsemilla")) return Response.json({ token: "tok", expira: new Date(Date.now() + 3_600_000).toISOString() });
      const h = extra[`${init?.method ?? "GET"} ${u.pathname}`];
      return h ? h(init) : Response.json({ error: "sin ruta" }, { status: 404 });
    };
    return { fetch, calls, client: new DgiiClient({ env: "TEST", certificate: cert, fetch }) };
  };

  it("consulta en el directorio dónde recibe un contribuyente", async () => {
    const d = dgii({
      "GET /testecf/consultadirectorio/api/consultas/obtenerdirectorioporrnc": () =>
        Response.json([{ nombre: "Proveedor SRL", rnc: "101672919", urlRecepcion: "https://prov.example/fe/recepcion/api/ecf", urlAceptacion: "https://prov.example", urlOpcional: "" }]),
    });
    expect(await d.client.directoryOf("101672919")).toEqual({
      name: "Proveedor SRL",
      rnc: "101672919",
      receptionUrl: "https://prov.example/fe/recepcion/api/ecf",
      approvalUrl: "https://prov.example",
      authenticationUrl: null,
    });
    expect(d.calls.at(-1)!.url).toContain("RNC=101672919");
    const none = dgii({ "GET /testecf/consultadirectorio/api/consultas/obtenerdirectorioporrnc": () => Response.json([]) });
    expect(await none.client.directoryOf("131246796")).toBeNull();
  });

  it("entrega a la DGII la copia de la aprobación y lee su respuesta", async () => {
    let name = "";
    const d = dgii({
      "POST /testecf/aprobacioncomercial/api/aprobacioncomercial": async (init) => {
        name = ((init!.body as FormData).get("xml") as File).name;
        return Response.json({ mensaje: ["Aprobación comercial recibida"], estado: "Aprobación comercial aprobada", codigo: "1" });
      },
    });
    expect(await d.client.submitApproval({ xml: "<ACECF/>", rnc: "130000002", encf: "E310000000001" })).toEqual({
      approved: true,
      status: "Aprobación comercial aprobada",
      code: "1",
      messages: ["Aprobación comercial recibida"],
    });
    expect(name).toBe("130000002E310000000001.xml");
    const rejected = dgii({ "POST /testecf/aprobacioncomercial/api/aprobacioncomercial": () => Response.json({ mensaje: ["Factura no encontrada para esta Aprobación comercial."], estado: "Aprobación comercial rechazada", codigo: "2" }, { status: 400 }) });
    await expect(rejected.client.submitApproval({ xml: "x", rnc: "1", encf: "E310000000001" })).rejects.toMatchObject({ kind: "rejected", message: "Factura no encontrada para esta Aprobación comercial." });
  });
});

describe("aprobación al emisor (otro contribuyente)", () => {
  const peerFetch = (routes: Record<string, (init?: RequestInit) => Response | Promise<Response>>) => {
    const calls: { method: string; url: string; auth: string | null }[] = [];
    const fetch: FetchLike = async (input, init) => {
      const u = new URL(input);
      calls.push({ method: init?.method ?? "GET", url: u.host + u.pathname, auth: new Headers(init?.headers).get("authorization") });
      const h = routes[`${init?.method ?? "GET"} ${u.host}${u.pathname}`];
      return h ? h(init) : new Response("sin ruta", { status: 404 });
    };
    return { fetch, calls };
  };
  const entry = { name: "P", rnc: "101672919", receptionUrl: null, approvalUrl: "https://prov.example", authenticationUrl: null };

  it("arma la dirección estándar a partir del host del directorio", () => {
    expect(peerEndpoint("https://prov.example/", "/fe/aprobacioncomercial/api/ecf")).toBe("https://prov.example/fe/aprobacioncomercial/api/ecf");
    expect(peerEndpoint("https://prov.example/ecf/fe/aprobacioncomercial/api/ecf", "/fe/aprobacioncomercial/api/ecf")).toBe("https://prov.example/ecf/fe/aprobacioncomercial/api/ecf");
  });

  it("entrega la aprobación sin autenticarse cuando el emisor no pide autenticación", async () => {
    let body = "";
    const p = peerFetch({ "POST prov.example/fe/aprobacioncomercial/api/ecf": async (init) => ((body = await ((init!.body as FormData).get("xml") as File).text()), new Response("", { status: 200 })) });
    await new PeerClient({ certificate: cert, fetch: p.fetch }).sendApproval(entry, "<ACECF/>", "130000002", "E310000000001");
    expect(body).toBe("<ACECF/>");
    expect(p.calls).toEqual([{ method: "POST", url: "prov.example/fe/aprobacioncomercial/api/ecf", auth: null }]);
  });

  it("si el emisor tiene autenticación, firma la semilla y manda el token", async () => {
    const p = peerFetch({
      "GET auth.example/fe/autenticacion/api/semilla": () => new Response("<SemillaModel><valor>xyz</valor></SemillaModel>"),
      "POST auth.example/fe/autenticacion/api/validacioncertificado": async (init) => {
        const xml = await ((init!.body as FormData).get("xml") as File).text();
        return verifyEcfSignature(xml) ? Response.json({ token: "peer-token", expira: "2026-10-22T16:30:00Z", expedido: "2026-10-22T15:30:00Z" }) : new Response("firma", { status: 400 });
      },
      "POST prov.example/fe/aprobacioncomercial/api/ecf": () => new Response("", { status: 200 }),
    });
    await new PeerClient({ certificate: cert, fetch: p.fetch }).sendApproval({ ...entry, authenticationUrl: "https://auth.example" }, "<ACECF/>", "1", "E310000000001");
    expect(p.calls.at(-1)).toMatchObject({ url: "prov.example/fe/aprobacioncomercial/api/ecf", auth: "bearer peer-token" });
  });

  it("distingue lo reintentable de lo definitivo", async () => {
    const send = (status: number) =>
      new PeerClient({ certificate: cert, fetch: peerFetch({ "POST prov.example/fe/aprobacioncomercial/api/ecf": () => new Response("motivo", { status }) }).fetch }).sendApproval(entry, "<ACECF/>", "1", "E310000000001");
    expect(await send(503).catch((e) => e)).toMatchObject({ kind: "server", retryable: true });
    expect(await send(400).catch((e) => e)).toMatchObject({ kind: "rejected", retryable: false, message: "motivo" });
    expect(await send(401).catch((e) => e)).toMatchObject({ kind: "auth" });
    const down = new PeerClient({ certificate: cert, fetch: async () => { throw new TypeError("x"); } });
    expect(await down.sendApproval(entry, "<ACECF/>", "1", "E310000000001").catch((e) => e)).toMatchObject({ kind: "network", retryable: true });
    expect(await down.sendApproval({ ...entry, approvalUrl: null }, "<ACECF/>", "1", "E310000000001").catch((e) => e)).toBeInstanceOf(FiscalError);
  });
});

describe("líneas de un e-CF recibido", () => {
  it("lee las líneas con su impuesto, códigos, descuento y la forma de pago", async () => {
    const { readIncomingBody } = await import("./index");
    const { xml } = supplierInvoice();
    const body = readIncomingBody(xml)!;
    expect(body.pricesIncludeTax).toBe(false);
    expect(body.paymentMethod).toBe("CASH");
    expect(body.seller.address).toBe("Av. Winston Churchill 100, Santo Domingo");
    expect(body.seller.email).toBe("ventas@example.com");
    expect(body.seller.phone).toBe("809-555-0100");
    expect(body.lines).toEqual([
      { lineNumber: 1, name: 'Café "molido" <1 lb>', codes: [{ type: "Interna", code: "CAF-01" }], tax: "ITBIS18", isService: false, quantity: "2.00", unitPrice: toCents("150.00"), discount: 0n, amount: toCents("300.00") },
      { lineNumber: 2, name: "Arroz", codes: [], tax: "EXENTO", isService: false, quantity: "1.50", unitPrice: toCents("40.00"), discount: toCents("5.00"), amount: toCents("55.00") },
    ]);
    expect(body.itbisWithheld).toBe(0n);
  });

  it("distingue precios con ITBIS incluido y pago a crédito; devuelve null si no es un e-CF", async () => {
    const { readIncomingBody } = await import("./index");
    const gross = buildEcf(sample("E31", { buyer: { docType: "RNC", docNumber: "130000002", name: "X" }, lines: [{ name: "Combo", quantity: 1000n, unitPrice: toCents("118.00"), tax: "ITBIS18", priceIncludesTax: true }], payments: [{ method: "CREDIT", amount: toCents("118.00") }], paymentDueDate: "2026-12-01" }));
    const body = readIncomingBody(gross.xml)!;
    expect(body.pricesIncludeTax).toBe(true);
    expect(body.paymentMethod).toBe("CREDIT");
    expect(readIncomingBody("<ECF><Encabezado/></ECF>")).toBeNull();
    expect(readIncomingBody("nada")).toBeNull();
  });
});

describe("precio unitario con más de 2 decimales", () => {
  it("se deduce del monto de la línea", async () => {
    const { readIncomingBody } = await import("./index");
    const { xml } = supplierInvoice();
    const odd = xml.replace("<PrecioUnitarioItem>150.00</PrecioUnitarioItem>", "<PrecioUnitarioItem>150.0000</PrecioUnitarioItem>").replace("<PrecioUnitarioItem>40.00</PrecioUnitarioItem>", "<PrecioUnitarioItem>39.9999</PrecioUnitarioItem>");
    const lines = readIncomingBody(odd)!.lines;
    expect(lines[0]!.unitPrice).toBe(toCents("150.00")); // 300.00 / 2
    expect(lines[1]!.unitPrice).toBe(toCents("40.00")); // (55.00 + 5.00) / 1.5
  });
});

describe("titular del certificado que firmó", () => {
  it("lee el RNC o la cédula del número de serie, del apellido (SN) o del nombre común", async () => {
    const { signerInfoOf, signXml } = await import("./index");
    const infoOf = (opts: Parameters<typeof testP12>[0]) => signerInfoOf(signXml("<Doc><v>1</v></Doc>", loadCertificate(...(Object.values(testP12(opts)) as [Uint8Array, string]))));
    expect(infoOf({ cn: "PROVEEDOR", serialNumber: "IDCDO-101672919" })).toMatchObject({ subject: "PROVEEDOR", rnc: "101672919" });
    expect(infoOf({ cn: "ANA PEREZ", serialNumber: "00112345678" })!.rnc).toBe("00112345678");
    expect(infoOf({ cn: "EMPRESA 131246796" })!.rnc).toBe("131246796");
    expect(infoOf({ cn: "SIN NUMERO" })!.rnc).toBeNull();
    expect(infoOf({ cn: "X", serialNumber: "1234567890123" })!.rnc).toBeNull(); // 13 dígitos: ni RNC ni cédula
    expect(signerInfoOf("<Doc/>")).toBeNull();
    expect(infoOf({ cn: "V", notAfter: new Date("2030-01-01T00:00:00Z") })!.notAfter.toISOString()).toBe("2030-01-01T00:00:00.000Z");
  });
});
