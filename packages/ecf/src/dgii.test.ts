import { describe, expect, it } from "vitest";
import { toCents } from "@facturacion/core";
import { buildEcf, DgiiClient, FiscalError, loadCertificate, signEcf, verifyEcfSignature, type FetchLike } from "./index";
import { sample, testP12 } from "./helpers.test-util";

const cert = loadCertificate(...(Object.values(testP12()) as [Uint8Array, string]));
const SEED = `<?xml version="1.0" encoding="utf-8"?><SemillaModel xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema"><valor>0000000-0000-0000-0000-000000000000</valor><fecha>2026-10-22T08:30:00.0000000-04:00</fecha></SemillaModel>`;

type Handler = (req: { url: URL; method: string; headers: Headers; form: FormData | null }) => Response | Promise<Response>;

/** Una DGII de mentira: enruta por «MÉTODO /ruta», valida el token y registra lo que recibe. */
function fakeDgii(routes: Record<string, Handler>, clock = { now: new Date("2026-10-22T12:00:00Z") }) {
  const calls: { method: string; path: string; auth: string | null; accept: string | null }[] = [];
  const state = { tokens: 0, seedsSigned: [] as string[] };
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    calls.push({ method, path: url.pathname + url.search, auth: headers.get("authorization"), accept: headers.get("accept") });
    const form = init?.body instanceof FormData ? init.body : null;
    const key = `${method} ${url.pathname}`;
    if (key === "GET /testecf/autenticacion/api/autenticacion/semilla") return new Response(SEED, { headers: { "content-type": "application/xml" } });
    if (key === "POST /testecf/autenticacion/api/autenticacion/validarsemilla") {
      const xml = await (form!.get("xml") as File).text();
      state.seedsSigned.push(xml);
      if (!verifyEcfSignature(xml) || !xml.includes("0000000-0000-0000-0000-000000000000")) return Response.json({ mensaje: "Semilla inválida" }, { status: 400 });
      state.tokens++;
      return Response.json({ token: `tok-${state.tokens}`, expira: new Date(clock.now.getTime() + 3_600_000).toISOString(), expedido: clock.now.toISOString() });
    }
    const handler = routes[key];
    if (!handler) return Response.json({ error: `sin ruta ${key}` }, { status: 404 });
    return handler({ url, method, headers, form });
  };
  return { fetch, calls, state, clock };
}

const valid = (state: { tokens: number }, headers: Headers) => headers.get("authorization") === `bearer tok-${state.tokens}`;

const client = (d: ReturnType<typeof fakeDgii>, over: Partial<ConstructorParameters<typeof DgiiClient>[0]> = {}) =>
  new DgiiClient({ env: "TEST", certificate: cert, fetch: d.fetch, now: () => d.clock.now, ...over });

describe("autenticación", () => {
  it("firma la semilla con el certificado y guarda el token mientras dure", async () => {
    const d = fakeDgii({ "GET /testecf/consultaresultado/api/consultas/estado": () => Response.json({ trackId: "T", codigo: 1, estado: "Aceptado" }) });
    const c = client(d);
    expect(await c.authenticate()).toBe("tok-1");
    expect(await c.authenticate()).toBe("tok-1");
    await c.result("T");
    expect(d.state.tokens).toBe(1);
    expect(d.calls.filter((x) => x.path.includes("semilla"))).toHaveLength(2); // pedir la semilla y validarla: una sola vez
    expect(d.calls[0]).toMatchObject({ method: "GET", accept: "*/*" });
    expect(d.state.seedsSigned[0]).toContain("<SignatureValue>");
    expect(d.calls.at(-1)!.auth).toBe("bearer tok-1");
  });

  it("renueva el token cuando está por vencer y comparte una sola autenticación entre peticiones simultáneas", async () => {
    const d = fakeDgii({ "GET /testecf/consultaresultado/api/consultas/estado": () => Response.json({ codigo: 3, estado: "En Proceso" }) });
    const c = client(d);
    await Promise.all([c.result("A"), c.result("B"), c.result("C")]);
    expect(d.state.tokens).toBe(1);
    d.clock.now = new Date(d.clock.now.getTime() + 3_600_000 - 30_000); // faltan 30 s: dentro del margen
    await c.result("D");
    expect(d.state.tokens).toBe(2);
    expect(d.calls.at(-1)!.auth).toBe("bearer tok-2");
  });

  it("si la DGII rechaza el token lo renueva y reintenta una sola vez", async () => {
    let first = true;
    const d = fakeDgii({
      "GET /testecf/consultaresultado/api/consultas/estado": ({ headers }) => {
        // El primer token se «vence» antes de tiempo; el segundo sí sirve.
        if (first || !valid(d.state, headers)) return ((first = false), Response.json({ mensaje: "Token vencido" }, { status: 401 }));
        return Response.json({ trackId: "T", codigo: 1, estado: "Aceptado" });
      },
    });
    const res = await client(d).result("T");
    expect(res.status).toBe("ACCEPTED");
    expect(d.state.tokens).toBe(2);

    const always401 = fakeDgii({ "GET /testecf/consultaresultado/api/consultas/estado": () => Response.json({ mensaje: "No autorizado" }, { status: 401 }) });
    await expect(client(always401).result("T")).rejects.toMatchObject({ kind: "auth", status: 401, message: "No autorizado" });
    expect(always401.state.tokens).toBe(2);
  });

  it("falla con claridad si la semilla o la firma no se aceptan", async () => {
    const bad = fakeDgii({});
    const noSeed: FetchLike = async () => new Response("<html>mantenimiento</html>");
    await expect(client(bad, { fetch: noSeed }).authenticate()).rejects.toMatchObject({ kind: "server", message: expect.stringMatching(/semilla/) });
    const noToken = fakeDgii({});
    const wrap: FetchLike = async (input, init) =>
      new URL(input).pathname.endsWith("validarsemilla") ? Response.json({ mensaje: "El certificado no está autorizado" }) : noToken.fetch(input, init);
    await expect(client(noToken, { fetch: wrap }).authenticate()).rejects.toMatchObject({ kind: "auth", message: "El certificado no está autorizado" });
  });
});

describe("recepción y consulta", () => {
  it("envía el e-CF firmado con el nombre RNC+e-NCF y devuelve el TrackId", async () => {
    const seen: { name: string; xml: string }[] = [];
    const d = fakeDgii({
      "POST /testecf/recepcion/api/facturaselectronicas": async ({ form, headers }) => {
        const file = form!.get("xml") as File;
        seen.push({ name: file.name, xml: await file.text() });
        expect(file.type).toBe("text/xml");
        expect(headers.get("authorization")).toBe("bearer tok-1");
        return Response.json({ trackId: "7f3c9d2e-0000-4000-8000-000000000001", error: null, mensaje: null });
      },
    });
    const built = buildEcf(sample("E32", { buyer: { docType: "RNC", docNumber: "130000002", name: "Cliente" }, lines: [{ name: "Equipo", quantity: 1000n, unitPrice: toCents("300000"), tax: "EXENTO" }], payments: [{ method: "TRANSFER", amount: toCents("300000") }] }));
    const signed = signEcf(built.xml, cert, new Date("2026-10-22T12:00:00Z"));
    const res = await client(d).submit({ xml: signed.xml, rnc: "101672919", encf: "E320000000001" });
    expect(res).toEqual({ trackId: "7f3c9d2e-0000-4000-8000-000000000001" });
    expect(seen[0]!.name).toBe("101672919E320000000001.xml");
    expect(seen[0]!.xml).toBe(signed.xml);
    expect(verifyEcfSignature(seen[0]!.xml)).toBe(true);
  });

  it("un envío rechazado en la recepción da el motivo de la DGII", async () => {
    const d = fakeDgii({ "POST /testecf/recepcion/api/facturaselectronicas": () => Response.json({ trackId: null, error: "XML", mensaje: "El e-NCF no está autorizado para el RNC emisor" }) });
    const err = await client(d).submit({ xml: "<ECF/>", rnc: "1", encf: "E320000000001" }).catch((e) => e);
    expect(err).toBeInstanceOf(FiscalError);
    expect(err).toMatchObject({ kind: "rejected", message: "El e-NCF no está autorizado para el RNC emisor", retryable: false });
    const http = fakeDgii({ "POST /testecf/recepcion/api/facturaselectronicas": () => Response.json({ error: "Estructura inválida" }, { status: 400 }) });
    await expect(client(http).submit({ xml: "<ECF/>", rnc: "1", encf: "E320000000001" })).rejects.toMatchObject({ kind: "rejected", status: 400, message: "Estructura inválida" });
  });

  it("traduce el resultado: estados, mensajes y si el número se puede reutilizar", async () => {
    const answers: Record<string, unknown> = {
      acc: { trackId: "acc", codigo: 1, estado: "Aceptado", rnc: "101672919", eNCF: "E320000000001", secuenciaUtilizada: true, fechaRecepcion: "22/10/2026 08:00:01", mensajes: [] },
      rej: { trackId: "rej", codigo: 2, estado: "Rechazado", rnc: "101672919", eNCF: "E320000000002", secuenciaUtilizada: false, fechaRecepcion: "22/10/2026 08:00:02", mensajes: [{ valor: "Firma inválida", codigo: 102 }, { valor: "Otro", codigo: 5 }] },
      wip: { trackId: "wip", codigo: 3, estado: "En Proceso", mensajes: [] },
      cond: { trackId: "cond", codigo: 4, estado: "Aceptado Condicional", mensajes: [{ valor: "Fecha de firma fuera de rango", codigo: 7 }] },
      none: { trackId: "none", codigo: 0, estado: "No encontrado", mensajes: [] },
    };
    const d = fakeDgii({ "GET /testecf/consultaresultado/api/consultas/estado": ({ url }) => Response.json(answers[url.searchParams.get("trackid")!]) });
    const c = client(d);
    const [acc, rej, wip, cond, none] = await Promise.all(["acc", "rej", "wip", "cond", "none"].map((t) => c.result(t)));
    expect(acc).toMatchObject({ status: "ACCEPTED", code: 1, encf: "E320000000001", rnc: "101672919", sequenceUsed: true, receivedAt: "22/10/2026 08:00:01", messages: [] });
    expect(rej).toMatchObject({ status: "REJECTED", sequenceUsed: false });
    expect(rej!.messages).toEqual([{ code: "102", text: "Firma inválida" }, { code: "5", text: "Otro" }]);
    expect([wip!.status, cond!.status, none!.status]).toEqual(["IN_PROCESS", "ACCEPTED_CONDITIONAL", "NOT_FOUND"]);
    expect(d.calls.some((x) => x.path.includes("trackid=acc"))).toBe(true);
  });

  it("lista los TrackIds de un e-NCF (uno o varios) y no existe en certificación", async () => {
    const d = fakeDgii({
      "GET /testecf/consultatrackids/api/trackids/consulta": ({ url }) => {
        expect(url.searchParams.get("rncemisor")).toBe("101672919");
        expect(url.searchParams.get("encf")).toBe("E320000000001");
        return Response.json([
          { trackId: "t1", estado: "Rechazado", fechaRecepcion: "22/10/2026 08:00" },
          { trackId: "t2", estado: "Aceptado Condicional", fechaRecepcion: "22/10/2026 08:05" },
        ]);
      },
    });
    expect(await client(d).trackIdsOf("101672919", "E320000000001")).toEqual([
      { trackId: "t1", status: "REJECTED", statusText: "Rechazado", receivedAt: "22/10/2026 08:00" },
      { trackId: "t2", status: "ACCEPTED_CONDITIONAL", statusText: "Aceptado Condicional", receivedAt: "22/10/2026 08:05" },
    ]);
    await expect(client(d, { env: "CERT" }).trackIdsOf("1", "E320000000001")).rejects.toMatchObject({ kind: "config" });
  });

  it("distingue la falta de red y los fallos del servidor (reintentables) de los rechazos", async () => {
    const down = new DgiiClient({ env: "TEST", certificate: cert, fetch: async () => { throw new TypeError("fetch failed"); } });
    const e1 = await down.result("T").catch((e) => e);
    expect(e1).toMatchObject({ kind: "network", retryable: true, message: "No se pudo conectar con la DGII" });

    const slow = new DgiiClient({ env: "TEST", certificate: cert, fetch: async () => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); } });
    expect(await slow.result("T").catch((e) => e)).toMatchObject({ kind: "network", message: expect.stringMatching(/tardó/) });

    const d = fakeDgii({ "GET /testecf/consultaresultado/api/consultas/estado": () => new Response("<Error><mensaje>Servicio en mantenimiento</mensaje></Error>", { status: 503 }) });
    expect(await client(d).result("T").catch((e) => e)).toMatchObject({ kind: "server", status: 503, retryable: true, message: "Servicio en mantenimiento" });
    const limited = fakeDgii({ "GET /testecf/consultaresultado/api/consultas/estado": () => new Response("", { status: 429 }) });
    expect(await client(limited).result("T").catch((e) => e)).toMatchObject({ kind: "server", status: 429, retryable: true });
  });

  it("usa la ruta de cada ambiente", async () => {
    const urls: string[] = [];
    const f: FetchLike = async (input) => (urls.push(input), new Response("", { status: 500 }));
    await new DgiiClient({ env: "PROD", certificate: cert, fetch: f }).authenticate().catch(() => undefined);
    await new DgiiClient({ env: "CERT", certificate: cert, fetch: f }).authenticate().catch(() => undefined);
    expect(urls).toEqual([
      "https://ecf.dgii.gov.do/ecf/autenticacion/api/autenticacion/semilla",
      "https://ecf.dgii.gov.do/certecf/autenticacion/api/autenticacion/semilla",
    ]);
  });
});
