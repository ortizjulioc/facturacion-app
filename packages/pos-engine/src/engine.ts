import { ApiClient, ApiError, type FetchLike } from "./api";
import { categories, getCompany, productByBarcode, productCount, searchCustomers, searchProducts, type Company } from "./catalog";
import { createSale, getSale, listSales, receiptOfSale, SaleError, type LocalSale, type Receipt, type SaleInput } from "./sales";
import { blocksOverview, DEFAULT_POLICY, runSync, type BlockPolicy, type SyncReport } from "./sync";
import { getMeta, one, openDb, run, setMeta, transaction, type Db } from "./store";

export { SaleError };

export type SecretBox = { encrypt(plain: string): string; decrypt(cipher: string): string };

export type EngineOptions = {
  /** Ruta del archivo SQLite (o ":memory:" en pruebas). */
  dbPath: string;
  fetch?: FetchLike;
  /** Cifra la cookie de sesión guardada (en Electron: `safeStorage`). Por defecto se guarda tal cual. */
  secretBox?: SecretBox;
  now?: () => Date;
  policy?: BlockPolicy;
  newId?: () => string;
};

export type PosState = {
  /** 'setup': falta conectar y elegir la caja. 'ready': lista para vender. */
  stage: "setup" | "ready";
  serverUrl: string | null;
  user: { id: string; name: string; email: string } | null;
  organization: { id: string; name: string } | null;
  terminal: { id: string; name: string; code: string } | null;
  /** La sesión con la nube se perdió o no existe: se puede vender, pero no sincronizar hasta iniciar sesión. */
  signedIn: boolean;
  lastSync: { at: string; ok: boolean } | null;
  pendingSales: number;
  rejectedSales: number;
  products: number;
  /** Números de e-NCF que quedan por tipo. */
  numbers: { E31: number; E32: number };
  company: Company | null;
};

const identityBox: SecretBox = { encrypt: (s) => s, decrypt: (s) => s };

const json = <T>(raw: string | null): T | null => (raw ? (JSON.parse(raw) as T) : null);

/**
 * La caja: todo lo que hace el programa, sin ventanas. La app Electron solo la expone por IPC y dibuja la pantalla;
 * las pruebas la usan directamente contra la API real.
 */
export class PosEngine {
  readonly db: Db;
  private api: ApiClient | null = null;
  private constructor(private readonly opts: EngineOptions) {
    this.db = openDb(opts.dbPath);
  }

  static open(opts: EngineOptions) {
    const engine = new PosEngine(opts);
    engine.restoreSession();
    return engine;
  }

  close() {
    this.db.close();
  }

  private get box() {
    return this.opts.secretBox ?? identityBox;
  }
  private now() {
    return this.opts.now?.() ?? new Date();
  }

  private makeApi(serverUrl: string, cookie: string | null) {
    return new ApiClient(serverUrl, {
      fetch: this.opts.fetch,
      cookie,
      onCookie: (c) => setMeta(this.db, "session_cookie", this.box.encrypt(c)),
    });
  }

  private restoreSession() {
    const url = getMeta(this.db, "server_url");
    if (!url) return;
    const stored = getMeta(this.db, "session_cookie");
    let cookie: string | null = null;
    try {
      cookie = stored ? this.box.decrypt(stored) : null;
    } catch {
      cookie = null; // no se pudo descifrar (otro usuario del sistema, otra máquina): hay que iniciar sesión otra vez
    }
    this.api = this.makeApi(url, cookie);
  }

  // ───────────── Estado ─────────────

  state(): PosState {
    const terminal = json<PosState["terminal"]>(getMeta(this.db, "terminal"));
    const now = this.now();
    const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Santo_Domingo" }).format(now);
    const blocks = blocksOverview(this.db, now).filter((b) => b.expiresAt >= today);
    const left = (t: string) => blocks.filter((b) => b.type === t).reduce((s, b) => s + b.remaining, 0);
    const count = (status: string) => one<{ n: number }>(this.db, "SELECT COUNT(*) AS n FROM sale WHERE status = ?", status)?.n ?? 0;
    return {
      stage: terminal ? "ready" : "setup",
      serverUrl: getMeta(this.db, "server_url"),
      user: json(getMeta(this.db, "user")),
      organization: json(getMeta(this.db, "organization")),
      terminal,
      signedIn: this.api?.hasSession ?? false,
      lastSync: json(getMeta(this.db, "last_sync")),
      pendingSales: count("PENDING"),
      rejectedSales: count("REJECTED"),
      products: productCount(this.db),
      numbers: { E31: left("E31"), E32: left("E32") },
      company: getCompany(this.db),
    };
  }

  // ───────────── Conexión ─────────────

  /**
   * Inicia sesión en la nube. Si la caja ya estaba configurada, solo renueva la sesión (los datos locales se conservan)
   * y vuelve a activar su empresa; si no, devuelve las empresas del usuario para elegir.
   */
  async signIn(input: { serverUrl: string; email: string; password: string }) {
    const serverUrl = input.serverUrl.trim().replace(/\/+$/, "");
    if (!/^https?:\/\//.test(serverUrl)) throw new SaleError("La dirección del servidor debe empezar con http:// o https://");
    const configured = getMeta(this.db, "server_url");
    if (configured && configured !== serverUrl && this.state().pendingSales > 0) {
      throw new SaleError("Hay ventas sin subir: sincroniza con el servidor anterior antes de cambiar de servidor");
    }
    const api = this.makeApi(serverUrl, null);
    const res = await api.signIn(input.email.trim(), input.password);
    this.api = api;
    setMeta(this.db, "server_url", serverUrl);
    setMeta(this.db, "user", JSON.stringify({ id: res.user.id, name: res.user.name, email: res.user.email }));
    const organizations = await api.organizations();

    const saved = json<{ id: string }>(getMeta(this.db, "organization"));
    if (saved && organizations.some((o) => o.id === saved.id)) {
      await api.setActiveOrganization(saved.id);
    }
    return { organizations: organizations.map((o) => ({ id: o.id, name: o.name })) };
  }

  /** Cajas activas de la empresa elegida (la deja activa en la sesión). */
  async terminals(organizationId: string) {
    const api = this.requireApi();
    await api.setActiveOrganization(organizationId);
    const res = await api.terminals();
    return res.data.filter((t) => t.active).map((t) => ({ id: t.id, name: t.name, code: t.code }));
  }

  /** Asocia esta instalación a una caja de la nube y hace la primera sincronización. */
  async selectTerminal(input: { organization: { id: string; name: string }; terminalId: string }): Promise<SyncReport> {
    const list = await this.terminals(input.organization.id);
    const terminal = list.find((t) => t.id === input.terminalId);
    if (!terminal) throw new SaleError("La caja no existe o está inactiva");

    const current = json<{ id: string }>(getMeta(this.db, "terminal"));
    if (current && current.id !== terminal.id) {
      if (this.state().pendingSales > 0) {
        throw new SaleError("Hay ventas sin subir: sincroniza antes de cambiar esta instalación a otra caja");
      }
      this.wipeCloudData();
    }
    setMeta(this.db, "organization", JSON.stringify(input.organization));
    setMeta(this.db, "terminal", JSON.stringify(terminal));
    return this.sync();
  }

  /** Borra lo bajado de la nube (catálogos y bloques); conserva el historial de ventas. */
  private wipeCloudData() {
    transaction(this.db, () => {
      for (const t of ["product", "customer", "category", "seq_block"]) run(this.db, `DELETE FROM ${t}`);
      setMeta(this.db, "catalog_cursor", null);
      setMeta(this.db, "company", null);
    });
  }

  async signOut() {
    try {
      await this.api?.signOut();
    } catch {
      // sin conexión: igual se descarta la sesión local
    }
    setMeta(this.db, "session_cookie", null);
    this.api = this.makeApi(getMeta(this.db, "server_url") ?? "http://localhost", null);
  }

  private requireApi() {
    if (!this.api) throw new SaleError("Configura primero el servidor");
    return this.api;
  }

  // ───────────── Sincronización ─────────────

  async sync(): Promise<SyncReport> {
    const terminal = json<{ id: string }>(getMeta(this.db, "terminal"));
    if (!terminal || !this.api) throw new SaleError("Esta caja aún no está configurada");
    if (!this.api.hasSession) {
      return {
        online: true,
        authRequired: true,
        catalog: null,
        blocks: { requested: 0, error: null },
        sales: { uploaded: 0, duplicates: 0, rejected: 0, pending: this.state().pendingSales },
        error: "Inicia sesión para sincronizar",
      };
    }
    return runSync(this.db, this.api, terminal.id, { policy: this.opts.policy ?? DEFAULT_POLICY, now: this.now() });
  }

  /** Vuelve a poner en cola una venta rechazada (después de corregir la causa en la nube). */
  retrySale(id: string) {
    run(this.db, "UPDATE sale SET status = 'PENDING', last_error = NULL WHERE id = ? AND status = 'REJECTED'", id);
  }

  // ───────────── Venta ─────────────

  products(q = "", categoryId?: string) {
    return searchProducts(this.db, q, { categoryId });
  }
  productByBarcode(code: string) {
    return productByBarcode(this.db, code);
  }
  customers(q: string) {
    return searchCustomers(this.db, q);
  }
  categories() {
    return categories(this.db);
  }

  sell(input: SaleInput): Receipt {
    const terminal = json<{ id: string }>(getMeta(this.db, "terminal"));
    if (!terminal) throw new SaleError("Esta caja aún no está configurada");
    return createSale(this.db, { terminalId: terminal.id, now: this.now(), newId: this.opts.newId }, input);
  }

  sales(opts?: { status?: LocalSale["status"]; limit?: number }) {
    return listSales(this.db, opts);
  }
  sale(id: string) {
    return getSale(this.db, id);
  }
  receipt(id: string) {
    return receiptOfSale(this.db, id);
  }
}

export { ApiError };
