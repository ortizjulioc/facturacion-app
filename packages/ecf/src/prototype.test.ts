import { describe, expect, it } from "vitest";
import { loadCertificate, runPrototype, verifyEcfSignature, type FetchLike, type PrototypeOptions } from "./index";
import { testP12 } from "./helpers.test-util";

const cert = loadCertificate(...(Object.values(testP12({ cn: "EMISOR DE PRUEBA" })) as [Uint8Array, string]));
const NOW = new Date("2026-10-23T15:30:00Z");
const SEED = `<?xml version="1.0"?><SemillaModel><valor>abc</valor><fecha>2026-10-23T08:00:00-04:00</fecha></SemillaModel>`;

const base = (over: Partial<PrototypeOptions> = {}): PrototypeOptions => ({
  env: "TEST",
  certificate: cert,
  rnc: "101672919",
  legalName: "EMISOR DE PRUEBA",
  address: "Calle 1",
  buyerRnc: "131000002",
  buyerName: "COMPRADOR DE PRUEBA",
  steps: ["e31", "e32", "e32-grande", "e34"],
  numbers: { E31: 7n, E32: 20n, E34: 3n },
  expiry: "2028-12-31",
  dryRun: false,
  now: () => NOW,
  pollMs: 0,
  sleep: async () => undefined,
  ...over,
});

/** Una DGII de mentira: autentica, recibe e-CF y resúmenes y contesta según `answers`. */
function fakeDgii(answers: { result?: (encf: string, call: number) => Record<string, unknown>; summary?: (encf: string) => Record<string, unknown>; fail?: (path: string) => Response | null } = {}) {
  const calls: { method: string; path: string; name?: string; xml?: string }[] = [];
  const polls = new Map<string, number>();
  const trackToEncf = new Map<string, string>();
  let n = 0;
  const fetch: FetchLike = async (input, init) => {
    const u = new URL(input);
    const method = init?.method ?? "GET";
    const form = init?.body instanceof FormData ? init.body : null;
    const file = form?.get("xml") as File | null | undefined;
    calls.push({ method, path: u.host + u.pathname, ...(file ? { name: file.name, xml: await file.text() } : {}) });
    const custom = answers.fail?.(u.pathname);
    if (custom) return custom;
    if (u.pathname.endsWith("/autenticacion/api/autenticacion/semilla")) return new Response(SEED);
    if (u.pathname.endsWith("/autenticacion/api/autenticacion/validarsemilla")) return Response.json({ token: "tok", expira: new Date(Date.now() + 3_600_000).toISOString() });
    if (u.pathname.endsWith("/recepcion/api/facturaselectronicas")) {
      const track = `trk-${++n}`;
      trackToEncf.set(track, /<eNCF>([^<]+)<\/eNCF>/.exec(await file!.text())![1]!);
      return Response.json({ trackId: track });
    }
    if (u.pathname.endsWith("/consultaresultado/api/consultas/estado")) {
      const track = u.searchParams.get("trackid")!;
      const encf = trackToEncf.get(track)!;
      const call = (polls.get(track) ?? 0) + 1;
      polls.set(track, call);
      const r = answers.result?.(encf, call) ?? (call < 2 ? { codigo: 3, estado: "En Proceso" } : { codigo: 1, estado: "Aceptado" });
      return Response.json({ trackId: track, eNCF: encf, mensajes: [], secuenciaUtilizada: true, ...r });
    }
    if (u.pathname.endsWith("/recepcionfc/api/recepcion/ecf")) {
      const encf = /<eNCF>([^<]+)<\/eNCF>/.exec(await file!.text())![1]!;
      return Response.json({ codigo: 1, estado: "Aceptado", mensajes: [], encf, secuenciaUtilizada: true, ...(answers.summary?.(encf) ?? {}) });
    }
    return Response.json({ error: `sin ruta ${u.pathname}` }, { status: 404 });
  };
  return { fetch, calls };
}

describe("prototipo contra TesteCF", () => {
  it("el simulacro arma y firma los cuatro comprobantes sin enviar nada", async () => {
    const d = fakeDgii();
    const r = await runPrototype(base({ dryRun: true, fetch: d.fetch }));
    expect(d.calls).toHaveLength(0);
    expect(r.authenticated).toBe(false);
    expect(r.results.map((x) => [x.step, x.encf, x.status, x.ok])).toEqual([
      ["e31", "E310000000007", "DRY_RUN", true],
      ["e32", "E320000000020", "DRY_RUN", true],
      ["e32-grande", "E320000000021", "DRY_RUN", true],
      ["e34", "E340000000003", "DRY_RUN", true],
    ]);
    expect(r.next).toEqual({ E31: 8n, E32: 22n, E34: 4n });
    const names = r.artifacts.map((a) => a.name);
    expect(names).toEqual(["101672919E310000000007.xml", "101672919E320000000020.xml", "101672919E320000000020.RFCE.xml", "101672919E320000000021.xml", "101672919E340000000003.xml"]);
    for (const a of r.artifacts) expect(verifyEcfSignature(a.content), a.name).toBe(true);
    expect(r.artifacts.find((a) => a.name.includes("E340000000003"))!.content).toContain("<NCFModificado>E310000000007</NCFModificado>");
    expect(r.results[0]!.qrUrl).toContain("https://ecf.dgii.gov.do/testecf/consultatimbre?rncemisor=101672919&rnccomprador=131000002&encf=E310000000007");
    expect(r.results[1]!.qrUrl).toContain("https://fc.dgii.gov.do/testecf/consultatimbrefc?");
    expect(r.results[2]!.qrUrl).toContain("https://ecf.dgii.gov.do/testecf/consultatimbre?"); // consumo de RD$295,000: e-CF completo
  });

  it("corre el flujo completo: autentica, envía, espera el resultado y manda el resumen del consumo", async () => {
    const d = fakeDgii();
    const lines: string[] = [];
    const r = await runPrototype(base({ fetch: d.fetch, log: (l) => lines.push(l) }));
    expect(r.authenticated).toBe(true);
    expect(r.fatal).toBeNull();
    expect(r.results.every((x) => x.ok)).toBe(true);
    expect(r.results.map((x) => x.status)).toEqual(["ACCEPTED", "ACCEPTED", "ACCEPTED", "ACCEPTED"]);
    expect(r.results[0]!.trackId).toBe("trk-1");
    expect(r.results[1]!.trackId).toBeNull(); // el resumen se contesta en el acto

    const received = d.calls.filter((c) => c.path.endsWith("/recepcion/api/facturaselectronicas"));
    expect(received.map((c) => c.name)).toEqual(["101672919E310000000007.xml", "101672919E320000000021.xml", "101672919E340000000003.xml"]);
    for (const c of received) expect(verifyEcfSignature(c.xml!)).toBe(true);
    const summaries = d.calls.filter((c) => c.path === "fc.dgii.gov.do/testecf/recepcionfc/api/recepcion/ecf");
    expect(summaries.map((c) => c.name)).toEqual(["101672919E320000000020.xml"]);
    expect(summaries[0]!.xml).toMatch(/^<\?xml[^>]*\?><RFCE>/);
    expect(lines.some((l) => l.includes("Autenticación"))).toBe(true);
    // El E31 tardó una consulta más (primero «En proceso»).
    expect(d.calls.filter((c) => c.path.endsWith("/consultaresultado/api/consultas/estado")).length).toBeGreaterThanOrEqual(6);
    expect(r.next).toEqual({ E31: 8n, E32: 22n, E34: 4n });
  });

  it("un rechazo queda en el informe con sus motivos, el número se da por gastado y la nota de crédito no se intenta", async () => {
    const d = fakeDgii({
      result: (encf) => (encf.startsWith("E31") ? { codigo: 2, estado: "Rechazado", secuenciaUtilizada: false, mensajes: [{ valor: "Firma inválida", codigo: 102 }] } : { codigo: 1, estado: "Aceptado" }),
    });
    const r = await runPrototype(base({ fetch: d.fetch }));
    const [e31, , , e34] = r.results;
    expect(e31).toMatchObject({ ok: false, status: "REJECTED", numberUsed: true });
    expect(e31!.messages).toEqual(["102: Firma inválida"]);
    expect(e34).toMatchObject({ ok: false, status: "ERROR" });
    expect(e34!.error).toMatch(/necesita un E31 aceptado/);
    expect(r.next.E31).toBe(8n);
    expect(r.results.filter((x) => x.ok)).toHaveLength(2);
  });

  it("si la autenticación falla, se detiene con un mensaje claro y no envía nada", async () => {
    const d = fakeDgii({ fail: (p) => (p.endsWith("validarsemilla") ? Response.json({ mensaje: "El certificado no está autorizado" }, { status: 401 }) : null) });
    const r = await runPrototype(base({ fetch: d.fetch }));
    expect(r.authenticated).toBe(false);
    expect(r.fatal).toMatch(/No se pudo autenticar con la DGII: El certificado no está autorizado/);
    expect(r.results).toHaveLength(0);
    expect(d.calls.some((c) => c.path.endsWith("/recepcion/api/facturaselectronicas"))).toBe(false);
  });

  it("un fallo de red en un paso no frena a los demás", async () => {
    const d = fakeDgii({ fail: (p) => (p.endsWith("/recepcionfc/api/recepcion/ecf") ? new Response("", { status: 503 }) : null) });
    const r = await runPrototype(base({ fetch: d.fetch, steps: ["e31", "e32", "e32-grande"] }));
    expect(r.results.map((x) => x.ok)).toEqual([true, false, true]);
    expect(r.results[1]!.error).toMatch(/503|responder/i);
    expect(r.next.E32).toBe(22n);
  });

  it("un comprobante que la DGII sigue procesando se informa sin darlo por bueno", async () => {
    const d = fakeDgii({ result: () => ({ codigo: 3, estado: "En Proceso" }) });
    const r = await runPrototype(base({ fetch: d.fetch, steps: ["e31"], maxPolls: 3 }));
    expect(r.results[0]).toMatchObject({ ok: false, status: "IN_PROCESS" });
    expect(r.results[0]!.error).toMatch(/sigue procesándolo/);
    expect(r.results[0]!.trackId).toBe("trk-1");
  });
});
