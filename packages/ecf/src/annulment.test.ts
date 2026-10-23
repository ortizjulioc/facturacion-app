import { describe, expect, it } from "vitest";
import { buildAnecf, DgiiClient, EcfError, loadCertificate, signReply, verifyEcfSignature, type FetchLike } from "./index";
import { testP12 } from "./helpers.test-util";

const cert = loadCertificate(...(Object.values(testP12()) as [Uint8Array, string]));
const AT = new Date("2026-10-23T15:30:05Z");

describe("anulación de rangos de e-NCF (ANECF)", () => {
  it("arma el archivo con el encabezado, una línea por tipo y los rangos", () => {
    const xml = buildAnecf({
      rnc: "123456789",
      at: AT,
      lines: [
        { type: "E31", ranges: [{ from: 1n, to: 5n }, { from: 50n, to: 91n }] },
        { type: "E43", ranges: [{ from: 10n, to: 46n }] },
      ],
    });
    expect(xml).toBe(
      "<ANECF><Encabezado><Version>1.0</Version><RncEmisor>123456789</RncEmisor><CantidadeNCFAnulados>84</CantidadeNCFAnulados><FechaHoraAnulacioneNCF>23-10-2026 11:30:05</FechaHoraAnulacioneNCF></Encabezado>" +
        "<DetalleAnulacion>" +
        "<Anulacion><NoLinea>1</NoLinea><TipoeCF>31</TipoeCF><TablaRangoSecuenciasAnuladaseNCF>" +
        "<Secuencia><SecuenciaeNCFDesde>E310000000001</SecuenciaeNCFDesde><SecuenciaeNCFHasta>E310000000005</SecuenciaeNCFHasta></Secuencia>" +
        "<Secuencia><SecuenciaeNCFDesde>E310000000050</SecuenciaeNCFDesde><SecuenciaeNCFHasta>E310000000091</SecuenciaeNCFHasta></Secuencia>" +
        "</TablaRangoSecuenciasAnuladaseNCF><CantidadeNCFAnulados>47</CantidadeNCFAnulados></Anulacion>" +
        "<Anulacion><NoLinea>2</NoLinea><TipoeCF>43</TipoeCF><TablaRangoSecuenciasAnuladaseNCF>" +
        "<Secuencia><SecuenciaeNCFDesde>E430000000010</SecuenciaeNCFDesde><SecuenciaeNCFHasta>E430000000046</SecuenciaeNCFHasta></Secuencia>" +
        "</TablaRangoSecuenciasAnuladaseNCF><CantidadeNCFAnulados>37</CantidadeNCFAnulados></Anulacion>" +
        "</DetalleAnulacion></ANECF>",
    );
  });

  it("ordena los rangos y rechaza lo que el formato no admite", () => {
    const base = { rnc: "123456789", at: AT };
    const ordered = buildAnecf({ ...base, lines: [{ type: "E32", ranges: [{ from: 20n, to: 30n }, { from: 1n, to: 2n }] }] });
    expect(ordered.indexOf("E320000000001")).toBeLessThan(ordered.indexOf("E320000000020"));
    const bad = (lines: Parameters<typeof buildAnecf>[0]["lines"], message: RegExp) => expect(() => buildAnecf({ ...base, lines })).toThrow(message);
    bad([], /al menos un rango/);
    bad([{ type: "E31", ranges: [] }], /no tiene rangos/);
    bad([{ type: "E31", ranges: [{ from: 5n, to: 4n }] }], /inválido/);
    bad([{ type: "E31", ranges: [{ from: 0n, to: 4n }] }], /inválido/);
    bad([{ type: "E31", ranges: [{ from: 1n, to: 10_000_000_000n }] }], /último número/);
    bad([{ type: "E31", ranges: [{ from: 1n, to: 10n }, { from: 10n, to: 12n }] }], /se solapan/);
    bad([{ type: "E31", ranges: [{ from: 1n, to: 2n }] }, { type: "E31", ranges: [{ from: 5n, to: 6n }] }], /dos veces/);
    expect(() => buildAnecf({ ...base, lines: [{ type: "E31", ranges: [{ from: 1n, to: 1n }] }] })).not.toThrow(EcfError);
  });

  it("se firma como los demás documentos", () => {
    const signed = signReply(buildAnecf({ rnc: "123456789", at: AT, lines: [{ type: "E32", ranges: [{ from: 10n, to: 20n }] }] }), cert, "ANECF", AT);
    expect(signed.startsWith('<?xml version="1.0" encoding="UTF-8"?><ANECF>')).toBe(true);
    expect(verifyEcfSignature(signed)).toBe(true);
    expect(verifyEcfSignature(signed.replace("<CantidadeNCFAnulados>11", "<CantidadeNCFAnulados>99"))).toBe(false);
  });
});

describe("anulación en la DGII", () => {
  const seed = `<?xml version="1.0"?><SemillaModel><valor>abc</valor><fecha>2026-10-23T08:00:00-04:00</fecha></SemillaModel>`;
  const dgii = (annul: (init?: RequestInit) => Response | Promise<Response>, env: "TEST" | "CERT" | "PROD" = "TEST") => {
    const calls: { url: string; name: string }[] = [];
    const fetch: FetchLike = async (input, init) => {
      const u = new URL(input);
      if (u.pathname.endsWith("/autenticacion/api/autenticacion/semilla")) return new Response(seed);
      if (u.pathname.endsWith("/autenticacion/api/autenticacion/validarsemilla")) return Response.json({ token: "tok", expira: new Date(Date.now() + 3_600_000).toISOString() });
      if (u.pathname.endsWith("/anulacionrangos/api/operaciones/anularrango")) {
        calls.push({ url: u.host + u.pathname, name: ((init!.body as FormData).get("xml") as File).name });
        return annul(init);
      }
      return new Response("", { status: 404 });
    };
    return { calls, client: new DgiiClient({ env, certificate: cert, fetch }) };
  };
  const input = { xml: "<ANECF/>", rnc: "123456789", firstEncf: "E310000000001" };

  it("envía el archivo firmado al servicio de anulación y lee que se anuló", async () => {
    const d = dgii(() => Response.json({ rnc: "123456789", codigo: "1", nombre: "Anulación", mensajes: ["Las secuencias fueron anuladas correctamente."] }));
    expect(await d.client.annulRanges(input)).toEqual({ annulled: true, code: "1", name: "Anulación", messages: ["Las secuencias fueron anuladas correctamente."] });
    expect(d.calls).toEqual([{ url: "ecf.dgii.gov.do/testecf/anulacionrangos/api/operaciones/anularrango", name: "123456789E310000000001.xml" }]);
  });

  it("no da por hecha una anulación parcial, y informa los rechazos", async () => {
    const partial = dgii(() => Response.json({ codigo: "2", nombre: "Parcial", mensajes: ["Las secuencias fueron anuladas correctamente. Con excepción de las secuencias del detalle"] }));
    expect(await partial.client.annulRanges(input)).toMatchObject({ annulled: false });
    const used = dgii(() => Response.json({ mensajes: ["Las secuencias que está intentando anular han sido utilizadas"] }, { status: 400 }));
    expect(await used.client.annulRanges(input).catch((e) => e)).toMatchObject({ kind: "rejected", message: expect.stringMatching(/han sido utilizadas/) });
    const down = dgii(() => new Response("", { status: 503 }));
    expect(await down.client.annulRanges(input).catch((e) => e)).toMatchObject({ kind: "server", retryable: true });
  });

  it("no existe en certificación", async () => {
    const d = dgii(() => Response.json({}), "CERT");
    expect(await d.client.annulRanges(input).catch((e) => e)).toMatchObject({ kind: "config" });
    expect(d.calls).toHaveLength(0);
  });
});
