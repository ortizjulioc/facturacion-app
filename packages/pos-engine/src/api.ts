/**
 * Cliente de la API de la nube para la caja. No usa nada de Electron: recibe un `fetch` y un almacén de cookie,
 * así se prueba contra la API real (o una simulada) sin abrir ninguna ventana.
 */

/** Origen con el que la caja se identifica ante la API (la API lo acepta como origen de confianza). */
export const POS_ORIGIN = "app://facturacion-pos";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** La nube respondió con un error HTTP. */
export class ApiError extends Error {
  override name = "ApiError";
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** No se pudo hablar con la nube (sin internet, servidor caído…): la caja sigue vendiendo con lo que tiene. */
export class NetworkError extends Error {
  override name = "NetworkError";
}

type Cookies = Map<string, string>;
const parse = (raw: string | null): Cookies =>
  new Map(
    (raw ?? "")
      .split(/;\s*/)
      .filter(Boolean)
      .map((p) => {
        const i = p.indexOf("=");
        return [p.slice(0, i), p.slice(i + 1)] as [string, string];
      }),
  );
const serialize = (c: Cookies) => [...c].map(([k, v]) => `${k}=${v}`).join("; ");

export class ApiClient {
  private cookies: Cookies;

  constructor(
    readonly baseUrl: string,
    private readonly opts: {
      fetch?: FetchLike;
      cookie?: string | null;
      /** Se llama cada vez que la sesión (cookie) cambia, para guardarla. */
      onCookie?: (cookie: string) => void;
      origin?: string;
    } = {},
  ) {
    this.cookies = parse(opts.cookie ?? null);
  }

  get hasSession() {
    return this.cookies.size > 0;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { origin: this.opts.origin ?? POS_ORIGIN };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.cookies.size > 0) headers.cookie = serialize(this.cookies);

    let res: Response;
    try {
      res = await (this.opts.fetch ?? fetch)(`${this.baseUrl.replace(/\/+$/, "")}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      throw new NetworkError(e instanceof Error ? e.message : "Sin conexión");
    }

    // Better Auth renueva la sesión con Set-Cookie: se conserva la más reciente.
    const setCookies = res.headers.getSetCookie?.() ?? [];
    if (setCookies.length > 0) {
      for (const sc of setCookies) {
        const [pair, ...attrs] = sc.split(/;\s*/);
        if (!pair) continue;
        const i = pair.indexOf("=");
        const name = pair.slice(0, i);
        const value = pair.slice(i + 1);
        const expired = attrs.some((a) => /^max-age=0$/i.test(a)) || value === "";
        if (expired) this.cookies.delete(name);
        else this.cookies.set(name, value);
      }
      this.opts.onCookie?.(serialize(this.cookies));
    }

    if (res.status === 204) return undefined as T;
    const json = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
    if (!res.ok) {
      throw new ApiError(json?.error ?? json?.message ?? `Error ${res.status}`, res.status);
    }
    return json as T;
  }

  // ───────────── Sesión ─────────────

  signIn(email: string, password: string) {
    return this.request<{ user: { id: string; name: string; email: string } }>("POST", "/api/auth/sign-in/email", { email, password });
  }
  organizations() {
    return this.request<{ id: string; name: string; slug: string }[]>("GET", "/api/auth/organization/list");
  }
  setActiveOrganization(organizationId: string) {
    return this.request<unknown>("POST", "/api/auth/organization/set-active", { organizationId });
  }
  signOut() {
    return this.request<unknown>("POST", "/api/auth/sign-out", {});
  }
  terminals() {
    return this.request<{ data: { id: string; name: string; code: string; active: boolean; branchId: string }[] }>("GET", "/v1/terminals");
  }

  // ───────────── Sincronización ─────────────

  catalog(cursor: string | null, limit = 500) {
    const q = new URLSearchParams({ limit: String(limit), ...(cursor ? { cursor } : {}) });
    return this.request<CatalogResponse>("GET", `/v1/sync/catalog?${q}`);
  }
  blocks(terminalId: string) {
    return this.request<{ data: CloudBlock[] }>("GET", `/v1/sync/sequence-blocks?terminalId=${terminalId}`);
  }
  requestBlock(terminalId: string, ecfType: "E31" | "E32" | "E34", size: number) {
    return this.request<{ data: CloudBlock }>("POST", "/v1/sync/sequence-blocks", { terminalId, ecfType, size });
  }
  cashiers() {
    return this.request<{ data: CashierInfo[] }>("GET", "/v1/sync/cashiers");
  }
  putShift(clientId: string, body: unknown) {
    return this.request<{ data: { id: string; clientId: string; status: string; expectedCash: string | null; difference: string | null } }>(
      "PUT",
      `/v1/sync/shifts/${clientId}`,
      body,
    );
  }
  uploadSale(payload: unknown) {
    return this.request<{ data: { id: string; encf: string; duplicate: boolean; ecf?: { securityCode: string; signedAt: string; qrUrl: string | null } | null } }>(
      "POST",
      "/v1/sync/sales",
      payload,
    );
  }
}

export type CatalogResponse = {
  data: {
    products: {
      id: string;
      name: string;
      sku: string | null;
      barcode: string | null;
      categoryId: string | null;
      price: string;
      priceIncludesTax: boolean;
      tax: string;
      unit: string;
      allowsDecimals: boolean;
      trackInventory: boolean;
      active: boolean;
    }[];
    customers: {
      id: string;
      name: string;
      documentType: string | null;
      documentNumber: string | null;
      email: string | null;
      phone: string | null;
      active: boolean;
    }[];
    categories: { id: string; name: string }[];
    company: {
      legalName: string;
      tradeName: string | null;
      rnc: string;
      address: string;
      phone: string | null;
      environment: string;
      requireShift?: boolean;
    } | null;
  };
  cursor: string;
  hasMore: boolean;
  serverTime: string;
};

/** Una persona que puede identificarse en la caja; `pin` es el resumen PBKDF2 (nunca el PIN). */
export type CashierInfo = { userId: string; name: string; email: string; role: string; pin: string };

export type CloudBlock = {
  id: string;
  terminalId: string;
  ecfType: "E31" | "E32" | "E34";
  fromNumber: number;
  toNumber: number;
  nextNumber: number;
  expiresAt: string;
  remaining: number;
};
