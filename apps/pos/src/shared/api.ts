import type {
  LocalCustomer,
  LocalProduct,
  LocalSale,
  PosState,
  Receipt,
  SaleInput,
  SyncReport,
} from "@facturacion/pos-engine";

export type { LocalCustomer, LocalProduct, LocalSale, PosState, Receipt, SaleInput, SyncReport };

/** Lo que la pantalla puede pedirle al programa. Cada método viaja por IPC al proceso principal, donde vive el motor. */
export type PosApi = {
  state(): Promise<PosState>;
  signIn(input: { serverUrl: string; email: string; password: string }): Promise<{ organizations: { id: string; name: string }[] }>;
  terminals(organizationId: string): Promise<{ id: string; name: string; code: string }[]>;
  selectTerminal(input: { organization: { id: string; name: string }; terminalId: string }): Promise<SyncReport>;
  signOut(): Promise<void>;
  sync(): Promise<SyncReport>;
  products(q: string, categoryId?: string): Promise<LocalProduct[]>;
  productByBarcode(code: string): Promise<LocalProduct | null>;
  customers(q: string): Promise<LocalCustomer[]>;
  categories(): Promise<{ id: string; name: string }[]>;
  sell(input: SaleInput): Promise<Receipt>;
  sales(opts?: { status?: LocalSale["status"]; limit?: number }): Promise<LocalSale[]>;
  receipt(id: string): Promise<Receipt | null>;
  retrySale(id: string): Promise<void>;
};

/** Lista de métodos (la usan el proceso principal y el preload para registrar cada canal). */
export const METHODS = [
  "state",
  "signIn",
  "terminals",
  "selectTerminal",
  "signOut",
  "sync",
  "products",
  "productByBarcode",
  "customers",
  "categories",
  "sell",
  "sales",
  "receipt",
  "retrySale",
] as const satisfies readonly (keyof PosApi)[];

/** Error que cruza el IPC: solo viaja el mensaje (y el código HTTP, si lo hubo). */
export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: { message: string; status?: number } };

export type PosBridge = PosApi & {
  /** Avisa cada vez que la sincronización automática termina. */
  onSynced(callback: (report: SyncReport) => void): () => void;
};
