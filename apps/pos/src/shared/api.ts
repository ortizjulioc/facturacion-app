import type {
  Cashier,
  LocalCustomer,
  LocalProduct,
  LocalSale,
  LocalShift,
  PosState,
  Receipt,
  RefundInput,
  ReturnableLine,
  SaleInput,
  ShiftReport,
  SyncReport,
} from "@facturacion/pos-engine";
import type { PrinterConfig } from "@facturacion/printing";

export type { PrinterConfig };
export type {
  Cashier,
  LocalCustomer,
  LocalProduct,
  LocalSale,
  LocalShift,
  PosState,
  Receipt,
  RefundInput,
  ReturnableLine,
  SaleInput,
  ShiftReport,
  SyncReport,
};

/** Estado de la auto-actualización de la caja. */
export type UpdateState = {
  phase: "idle" | "checking" | "downloading" | "ready" | "error";
  /** Versión instalada. */
  current: string;
  /** Última vez que se revisó (ISO), o null si aún no. */
  checkedAt: string | null;
  /** Versión nueva que se descarga o está lista. */
  version: string | null;
  percent: number;
  /** Último error al revisar (sin internet, servidor sin versiones…); no es grave. */
  message: string | null;
};

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
  cashiers(): Promise<Cashier[]>;
  unlock(userId: string, pin: string): Promise<Cashier>;
  lock(): Promise<void>;
  returnable(saleId: string): Promise<{ encf: string; propinaLegal: boolean; lines: ReturnableLine[]; hasCredit: boolean }>;
  refund(input: RefundInput): Promise<Receipt>;
  openShift(openingAmount: string): Promise<LocalShift>;
  closeShift(input: { countedCash: string; notes?: string | null }): Promise<{ shift: LocalShift; report: ShiftReport }>;
  shifts(): Promise<LocalShift[]>;
  shiftReport(id?: string): Promise<{ shift: LocalShift; report: ShiftReport } | null>;
  /** Impresoras instaladas en Windows (para elegir una). */
  printers(): Promise<string[]>;
  printerConfig(): Promise<PrinterConfig>;
  savePrinterConfig(config: Partial<PrinterConfig>): Promise<PrinterConfig>;
  /** Imprime el ticket de una venta o nota de crédito. `reprint`: copia (no abre la gaveta). */
  printReceipt(saleId: string, opts?: { reprint?: boolean }): Promise<void>;
  /** Imprime el informe X/Z de un turno (el abierto si no se indica). */
  printShift(shiftId?: string): Promise<void>;
  openDrawer(): Promise<void>;
  testPrint(config?: Partial<PrinterConfig>): Promise<void>;
  /** Auto-actualización: estado, revisar ahora, y cerrar e instalar la versión ya descargada. */
  updateState(): Promise<UpdateState>;
  checkUpdates(): Promise<UpdateState>;
  installUpdate(): Promise<boolean>;
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
  "cashiers",
  "unlock",
  "lock",
  "returnable",
  "refund",
  "openShift",
  "closeShift",
  "shifts",
  "shiftReport",
  "printers",
  "printerConfig",
  "savePrinterConfig",
  "printReceipt",
  "printShift",
  "openDrawer",
  "testPrint",
  "updateState",
  "checkUpdates",
  "installUpdate",
] as const satisfies readonly (keyof PosApi)[];

/** Error que cruza el IPC: solo viaja el mensaje (y el código HTTP, si lo hubo). */
export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: { message: string; status?: number } };

export type PosBridge = PosApi & {
  /** Avisa cada vez que la sincronización automática termina. */
  onSynced(callback: (report: SyncReport) => void): () => void;
  /** Avisa cuando una impresión automática (al vender o devolver) falla. */
  onPrintFailed(callback: (info: { saleId: string; message: string }) => void): () => void;
  /** Avisa cada vez que cambia el estado de la actualización. */
  onUpdate(callback: (state: UpdateState) => void): () => void;
};
