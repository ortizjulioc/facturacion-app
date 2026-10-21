import { applyCatalog } from "./catalog";
import { openDb, run, type Db } from "./store";
import type { CatalogResponse, FetchLike } from "./api";

export const TERMINAL = "11111111-1111-4111-8111-111111111111";

type CatalogData = CatalogResponse["data"];

export const product = (over: Partial<CatalogData["products"][number]> = {}): CatalogData["products"][number] => ({
  id: crypto.randomUUID(),
  name: "Producto 118",
  sku: null,
  barcode: null,
  categoryId: null,
  price: "118.00",
  priceIncludesTax: true,
  tax: "ITBIS18",
  unit: "UND",
  allowsDecimals: false,
  trackInventory: false,
  active: true,
  ...over,
});

export const customer = (over: Partial<CatalogData["customers"][number]> = {}): CatalogData["customers"][number] => ({
  id: crypto.randomUUID(),
  name: "Cliente",
  documentType: null,
  documentNumber: null,
  email: null,
  phone: null,
  active: true,
  ...over,
});

/** Base local en memoria con catálogo y un bloque de e-NCF. */
export function makeDb(opts: { products?: CatalogData["products"]; customers?: CatalogData["customers"]; block?: { type?: string; from?: number; to?: number; expires?: string } | null } = {}): Db {
  const db = openDb(":memory:");
  applyCatalog(db, {
    products: opts.products ?? [],
    customers: opts.customers ?? [],
    categories: [],
    company: { legalName: "Empresa SRL", tradeName: null, rnc: "101001577", address: "Calle 1", phone: null, environment: "TEST" },
  });
  if (opts.block !== null) {
    const b = opts.block ?? {};
    run(
      db,
      "INSERT INTO seq_block (id, ecf_type, from_number, to_number, next_number, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
      crypto.randomUUID(),
      b.type ?? "E32",
      b.from ?? 1,
      b.to ?? 100,
      b.from ?? 1,
      b.expires ?? "2099-12-31",
    );
  }
  return db;
}

type Handler = (req: { url: URL; method: string; body: unknown; headers: Headers }) => Response | Promise<Response>;

/** `fetch` falso: enruta por "MÉTODO /ruta" a funciones, y registra lo que se pidió. */
export function fakeCloud(routes: Record<string, Handler>) {
  const calls: { method: string; path: string; body: unknown; headers: Headers }[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const headers = new Headers(init?.headers);
    calls.push({ method, path: url.pathname + url.search, body, headers });
    const handler = routes[`${method} ${url.pathname}`];
    if (!handler) return Response.json({ error: `sin ruta ${method} ${url.pathname}` }, { status: 404 });
    return handler({ url, method, body, headers });
  };
  return { fetch, calls };
}
