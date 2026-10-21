import { describe, expect, it } from "vitest";
import { ApiClient, POS_ORIGIN } from "./api";
import { createSale, getSale } from "./sales";
import { pullCatalog, pushSales, remainingNumbers, runSync, topUpBlocks } from "./sync";
import { getMeta, one, run } from "./store";
import { fakeCloud, makeDb, product, TERMINAL } from "./helpers.test-util";

const NOW = new Date("2026-10-21T15:00:00Z");

/** Tres ventas hechas sin conexión. */
function threeSales() {
  const p = product();
  const db = makeDb({ products: [p] });
  const ids = ["a", "b", "c"].map((_, i) => `00000000-0000-4000-8000-00000000000${i + 1}`);
  let n = 0;
  for (const _ of ids) {
    createSale(db, { terminalId: TERMINAL, now: new Date(NOW.getTime() + n * 1000), newId: () => ids[n++]! }, {
      type: "E32",
      lines: [{ productId: p.id, quantity: "1" }],
      payments: [{ method: "CASH", amount: "118.00" }],
    });
  }
  return { db, ids };
}

const ok = (id: string, encf: string, duplicate = false) => Response.json({ data: { id, encf, duplicate } }, { status: duplicate ? 200 : 201 });

describe("cliente de la API", () => {
  it("envía el origen de la caja, conserva la cookie de sesión y avisa cuando cambia", async () => {
    const saved: string[] = [];
    const { fetch, calls } = fakeCloud({
      "POST /api/auth/sign-in/email": () =>
        new Response(JSON.stringify({ user: { id: "u1", name: "Ana", email: "a@x.com" } }), {
          headers: [["content-type", "application/json"], ["set-cookie", "better-auth.session=abc; Path=/; HttpOnly"], ["set-cookie", "otra=1; Path=/"]],
        }),
      "GET /v1/terminals": () => Response.json({ data: [] }),
    });
    const api = new ApiClient("https://api.test/", { fetch, onCookie: (c) => saved.push(c) });
    expect(api.hasSession).toBe(false);
    await api.signIn("a@x.com", "clave");
    expect(api.hasSession).toBe(true);
    expect(saved.at(-1)).toBe("better-auth.session=abc; otra=1");
    await api.terminals();
    expect(calls[0]!.headers.get("origin")).toBe(POS_ORIGIN);
    expect(calls[1]!.headers.get("cookie")).toBe("better-auth.session=abc; otra=1");
    expect(calls[1]!.path).toBe("/v1/terminals");
  });

  it("distingue errores del servidor de la falta de red", async () => {
    const { fetch } = fakeCloud({ "GET /v1/terminals": () => Response.json({ error: "No autenticado" }, { status: 401 }) });
    const api = new ApiClient("https://api.test", { fetch });
    await expect(api.terminals()).rejects.toMatchObject({ status: 401, message: "No autenticado" });
    const down = new ApiClient("https://api.test", { fetch: async () => { throw new TypeError("fetch failed"); } });
    await expect(down.terminals()).rejects.toMatchObject({ name: "NetworkError" });
  });
});

describe("subida de ventas", () => {
  it("sube en orden, marca sincronizadas y cuenta los duplicados", async () => {
    const { db, ids } = threeSales();
    const seen: string[] = [];
    const { fetch } = fakeCloud({
      "POST /v1/sync/sales": ({ body }) => {
        const b = body as { clientId: string; encf: string };
        seen.push(b.encf);
        return ok(`remote-${b.clientId.slice(-1)}`, b.encf, b.clientId === ids[1]);
      },
    });
    const res = await pushSales(db, new ApiClient("https://api.test", { fetch }), NOW);
    expect(res).toEqual({ uploaded: 2, duplicates: 1, rejected: 0 });
    expect(seen).toEqual(["E320000000001", "E320000000002", "E320000000003"]);
    expect(getSale(db, ids[0]!)).toMatchObject({ status: "SYNCED", syncedAt: NOW.toISOString() });
    // Una segunda ronda no vuelve a subir nada.
    expect(await pushSales(db, new ApiClient("https://api.test", { fetch }), NOW)).toEqual({ uploaded: 0, duplicates: 0, rejected: 0 });
  });

  it("un rechazo definitivo se marca con su motivo y sigue con las demás", async () => {
    const { db, ids } = threeSales();
    const { fetch } = fakeCloud({
      "POST /v1/sync/sales": ({ body }) => {
        const b = body as { clientId: string; encf: string };
        return b.clientId === ids[0] ? Response.json({ error: "El total no coincide" }, { status: 422 }) : ok("r", b.encf);
      },
    });
    const res = await pushSales(db, new ApiClient("https://api.test", { fetch }), NOW);
    expect(res).toEqual({ uploaded: 2, duplicates: 0, rejected: 1 });
    expect(getSale(db, ids[0]!)).toMatchObject({ status: "REJECTED", lastError: "El total no coincide", attempts: 1 });
  });

  it("un corte de red detiene el envío y las ventas quedan pendientes para el próximo intento", async () => {
    const { db, ids } = threeSales();
    let calls = 0;
    const flaky = async (input: string, init?: RequestInit) => {
      if (++calls === 2) throw new TypeError("fetch failed");
      return ok("r", JSON.parse(String(init!.body)).encf);
    };
    const api = new ApiClient("https://api.test", { fetch: flaky });
    await expect(pushSales(db, api, NOW)).rejects.toMatchObject({ name: "NetworkError" });
    expect(getSale(db, ids[0]!)?.status).toBe("SYNCED");
    expect(getSale(db, ids[1]!)).toMatchObject({ status: "PENDING", attempts: 1 });
    expect(getSale(db, ids[2]!)).toMatchObject({ status: "PENDING", attempts: 0 });
    // Al volver la red se completa lo que faltaba.
    expect(await pushSales(db, new ApiClient("https://api.test", { fetch: flaky }), NOW)).toMatchObject({ uploaded: 2 });
  });

  it("una sesión vencida o un error del servidor no marcan la venta como rechazada", async () => {
    const { db, ids } = threeSales();
    for (const status of [401, 500]) {
      const { fetch } = fakeCloud({ "POST /v1/sync/sales": () => Response.json({ error: "x" }, { status }) });
      await expect(pushSales(db, new ApiClient("https://api.test", { fetch }), NOW)).rejects.toMatchObject({ status });
    }
    expect(getSale(db, ids[0]!)?.status).toBe("PENDING");
  });
});

describe("catálogo y bloques", () => {
  it("baja el catálogo por lotes, guarda el cursor y lo reutiliza", async () => {
    const db = makeDb({ block: null });
    const a = product({ name: "A" });
    const b = product({ name: "B" });
    const requested: (string | null)[] = [];
    const { fetch } = fakeCloud({
      "GET /v1/sync/catalog": ({ url }) => {
        const cursor = url.searchParams.get("cursor");
        requested.push(cursor);
        const page = cursor === null ? [a] : cursor === "c1" ? [b] : [];
        return Response.json({
          data: { products: page, customers: [], categories: [], company: null },
          cursor: cursor === null ? "c1" : "c2",
          hasMore: cursor === null,
          serverTime: NOW.toISOString(),
        });
      },
    });
    const api = new ApiClient("https://api.test", { fetch });
    expect(await pullCatalog(db, api)).toEqual({ products: 2, customers: 0 });
    expect(requested).toEqual([null, "c1"]);
    expect(getMeta(db, "catalog_cursor")).toBe("c2");
    await pullCatalog(db, api);
    expect(requested.at(-1)).toBe("c2"); // la siguiente ronda parte del último cursor
  });

  it("pide un bloque cuando quedan pocos números y recupera los que la nube ya había entregado", async () => {
    const db = makeDb({ block: { from: 1, to: 100 } });
    run(db, "UPDATE seq_block SET next_number = 95"); // quedan 6
    const orphan = { id: "huerfano", terminalId: TERMINAL, ecfType: "E31", fromNumber: 10, toNumber: 59, nextNumber: 10, expiresAt: "2099-12-31", remaining: 50 };
    const requested: unknown[] = [];
    const { fetch } = fakeCloud({
      "GET /v1/sync/sequence-blocks": () => Response.json({ data: [orphan] }),
      "POST /v1/sync/sequence-blocks": ({ body }) => {
        requested.push(body);
        const t = (body as { ecfType: string }).ecfType;
        return Response.json({ data: { ...orphan, id: `nuevo-${t}`, ecfType: t, fromNumber: 200, toNumber: 399, nextNumber: 200, remaining: 200 } }, { status: 201 });
      },
    });
    const res = await topUpBlocks(db, new ApiClient("https://api.test", { fetch }), TERMINAL, { types: ["E32", "E31"], size: 200, low: 40 }, NOW);
    // E32 tenía 6 (< 40): pide uno. E31 se recuperó del huérfano (50 ≥ 40): no pide.
    expect(requested).toEqual([{ terminalId: TERMINAL, ecfType: "E32", size: 200 }]);
    expect(res).toEqual({ requested: 1, error: null });
    expect(remainingNumbers(db, "E32", "2026-10-21")).toBe(6 + 200);
    expect(remainingNumbers(db, "E31", "2026-10-21")).toBe(50);
    // Repetirlo no duplica el bloque recuperado.
    await topUpBlocks(db, new ApiClient("https://api.test", { fetch }), TERMINAL, { types: ["E32", "E31"], size: 200, low: 40 }, NOW);
    expect(one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM seq_block WHERE id = 'huerfano'")!.n).toBe(1);
  });

  it("informa, sin fallar, cuando la nube no tiene rango para entregar", async () => {
    const db = makeDb({ block: null });
    const { fetch } = fakeCloud({
      "GET /v1/sync/sequence-blocks": () => Response.json({ data: [] }),
      "POST /v1/sync/sequence-blocks": () => Response.json({ error: "No hay un rango general con 200 números disponibles" }, { status: 422 }),
    });
    const res = await topUpBlocks(db, new ApiClient("https://api.test", { fetch }), TERMINAL, { types: ["E32"], size: 200, low: 40 }, NOW);
    expect(res.requested).toBe(0);
    expect(res.error).toMatch(/E32: No hay un rango general/);
  });
});

describe("ronda de sincronización", () => {
  it("sin conexión no falla: informa que está offline y deja todo pendiente", async () => {
    const { db } = threeSales();
    const down = new ApiClient("https://api.test", { fetch: async () => { throw new TypeError("fetch failed"); } });
    const report = await runSync(db, down, TERMINAL, { now: NOW });
    expect(report).toMatchObject({ online: false, authRequired: false, error: "Sin conexión con la nube", sales: { pending: 3 } });
    expect(JSON.parse(getMeta(db, "last_sync")!)).toEqual({ at: NOW.toISOString(), ok: false });
  });

  it("detecta la sesión vencida", async () => {
    const { db } = threeSales();
    const { fetch } = fakeCloud({ "POST /v1/sync/sales": () => Response.json({ error: "No autenticado" }, { status: 401 }) });
    const report = await runSync(db, new ApiClient("https://api.test", { fetch }), TERMINAL, { now: NOW });
    expect(report).toMatchObject({ authRequired: true, online: true, sales: { pending: 3 } });
  });
});
