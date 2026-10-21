import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, ipcMain, Menu, safeStorage, shell } from "electron";
import { ApiError, PosEngine, type SecretBox, type SyncReport } from "@facturacion/pos-engine";
import {
  colsOf,
  drawerOnly,
  normalizePrinterConfig,
  printBytes,
  receiptTicket,
  shiftTicket,
  testTicket,
  type PrinterConfig,
  type ReceiptData,
} from "@facturacion/printing";
import { METHODS, type IpcResult, type PosApi } from "../shared/api";

/**
 * Proceso principal: dueño de la base de datos SQLite y del motor de la caja. La pantalla (renderer) no toca nada
 * del sistema: solo llama a los métodos de `PosApi` por IPC.
 */

// Para pruebas y para varias cajas en la misma PC (cada una con su carpeta de datos).
if (process.env.POS_USER_DATA) app.setPath("userData", process.env.POS_USER_DATA);

const smoke = process.env.POS_SMOKE === "1";
if (!smoke && !app.requestSingleInstanceLock()) app.quit();

/** La cookie de sesión se guarda cifrada con el almacén seguro del sistema operativo (DPAPI en Windows). */
const secretBox: SecretBox = {
  encrypt: (plain) =>
    safeStorage.isEncryptionAvailable() ? `enc:${safeStorage.encryptString(plain).toString("base64")}` : plain,
  decrypt: (stored) =>
    stored.startsWith("enc:") ? safeStorage.decryptString(Buffer.from(stored.slice(4), "base64")) : stored,
};

let engine: PosEngine;
let win: BrowserWindow | null = null;

// Una sincronización a la vez: el temporizador y el botón comparten la misma en curso.
let syncing: Promise<SyncReport> | null = null;
const syncOnce = () => (syncing ??= engine.sync().finally(() => (syncing = null)));

// ───────────── Impresión ─────────────
// Una impresión a la vez (los tickets no se mezclan), y la venta nunca espera a la impresora.
let printing: Promise<unknown> = Promise.resolve();
const enqueue = <T>(job: () => Promise<T>): Promise<T> => {
  const run = printing.then(job, job);
  printing = run.catch(() => undefined);
  return run;
};

const ticketOpts = (c: PrinterConfig, extra: { openDrawer?: boolean } = {}) => ({
  cols: colsOf(c.paper),
  codePage: c.codePage,
  openDrawer: extra.openDrawer ?? false,
});

/** El comprobante tal como lo imprime la térmica; abre la gaveta si hubo efectivo y no es una reimpresión. */
function receiptBytes(saleId: string, config: PrinterConfig, reprint: boolean) {
  const receipt = engine.receipt(saleId);
  if (!receipt) throw new Error("No se encontró la venta");
  const cash = receipt.payments.some((p) => p.method === "CASH");
  return receiptTicket(receipt as ReceiptData, ticketOpts(config, { openDrawer: !reprint && config.drawerOnCash && cash }));
}

/** Imprime sin bloquear la venta: si falla, avisa a la pantalla para que ofrezca reintentar. */
function autoPrint(saleId: string) {
  const config = engine.printerConfig();
  if (config.mode === "none" || !config.autoPrint) return;
  void enqueue(async () => printBytes(config, receiptBytes(saleId, config, false))).catch((e: unknown) => {
    win?.webContents.send("pos:print-failed", { saleId, message: e instanceof Error ? e.message : String(e) });
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 640,
    show: !smoke,
    // En los escenarios de verificación la ventana se muestra transparente: una ventana oculta no genera imágenes para las capturas.
    ...(smoke && process.env.POS_SCRIPT ? { focusable: false, skipTaskbar: true } : {}),
    title: "Facturación · Caja",
    backgroundColor: "#0b0b0c",
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  if (smoke && process.env.POS_SCRIPT) {
    win.setOpacity(0); // invisible pero pintada: así las capturas salen bien sin molestar en pantalla
    win.setIgnoreMouseEvents(true);
    win.showInactive();
  }

  // La pantalla no navega a ningún sitio ni abre ventanas nuevas: los enlaces externos van al navegador.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (url !== win?.webContents.getURL()) e.preventDefault();
  });

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(join(import.meta.dirname, "../renderer/index.html"));
}

function register() {
  const handlers: { [K in keyof PosApi]: (...args: Parameters<PosApi[K]>) => ReturnType<PosApi[K]> | Awaited<ReturnType<PosApi[K]>> } = {
    state: () => engine.state(),
    signIn: (input) => engine.signIn(input),
    terminals: (organizationId) => engine.terminals(organizationId),
    selectTerminal: (input) => engine.selectTerminal(input),
    signOut: () => engine.signOut(),
    sync: () => syncOnce(),
    products: (q, categoryId) => engine.products(q, categoryId),
    productByBarcode: (code) => engine.productByBarcode(code),
    customers: (q) => engine.customers(q),
    categories: () => engine.categories(),
    sell: (input) => {
      const receipt = engine.sell(input);
      autoPrint(receipt.sale.id);
      // Intenta subirla enseguida (sin esperar): si no hay internet queda en la cola y sale en la próxima ronda.
      void syncOnce().then(notify, () => undefined);
      return receipt;
    },
    sales: (opts) => engine.sales(opts),
    receipt: (id) => engine.receipt(id),
    retrySale: (id) => engine.retrySale(id),
    cashiers: () => engine.cashiers(),
    unlock: (userId, pin) => engine.unlock(userId, pin),
    lock: () => engine.lock(),
    returnable: (saleId) => engine.returnable(saleId),
    refund: (input) => {
      const receipt = engine.refund(input);
      autoPrint(receipt.sale.id);
      void syncOnce().then(notify, () => undefined);
      return receipt;
    },
    openShift: (amount) => engine.openShift(amount),
    closeShift: (input) => {
      const result = engine.closeShift(input);
      void syncOnce().then(notify, () => undefined); // sube el cierre en cuanto hay conexión
      return result;
    },
    shifts: () => engine.shifts(),
    shiftReport: (id) => engine.shiftReport(id),
    printers: async () => (await win!.webContents.getPrintersAsync()).map((p) => p.name),
    printerConfig: () => engine.printerConfig(),
    savePrinterConfig: (config) => engine.savePrinterConfig(config),
    printReceipt: (saleId, opts) => {
      const config = engine.printerConfig();
      return enqueue(async () => printBytes(config, receiptBytes(saleId, config, opts?.reprint ?? false)));
    },
    printShift: (shiftId) => {
      const config = engine.printerConfig();
      const data = engine.shiftReport(shiftId);
      if (!data) throw new Error("No hay un turno para imprimir");
      return enqueue(async () => printBytes(config, shiftTicket({ ...data, company: engine.state().company }, ticketOpts(config))));
    },
    openDrawer: () => {
      const config = engine.printerConfig();
      return enqueue(async () => printBytes(config, drawerOnly(ticketOpts(config))));
    },
    // Imprime con la configuración que se está editando (aún sin guardar), para probarla.
    testPrint: (draft) => {
      const config = normalizePrinterConfig({ ...engine.printerConfig(), ...draft });
      return enqueue(async () => printBytes(config, testTicket(ticketOpts(config, { openDrawer: false }))));
    },
  };

  for (const name of METHODS) {
    ipcMain.handle(`pos:${name}`, async (_event, ...args: unknown[]): Promise<IpcResult<unknown>> => {
      try {
        const fn = handlers[name] as (...a: unknown[]) => unknown;
        return { ok: true, value: await fn(...args) };
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        return { ok: false, error: { message: error.message, status: e instanceof ApiError ? e.status : undefined } };
      }
    });
  }
}

const notify = (report: SyncReport) => win?.webContents.send("pos:synced", report);

app.whenReady().then(() => {
  engine = PosEngine.open({ dbPath: join(app.getPath("userData"), "pos.sqlite"), secretBox });
  register();
  Menu.setApplicationMenu(null);
  createWindow();

  // Sincronización automática cada minuto (si la caja está configurada y con sesión).
  setInterval(() => {
    const s = engine.state();
    if (s.stage === "ready" && s.signedIn) void syncOnce().then(notify, () => undefined);
  }, 60_000);

  if (smoke) void runSmoke();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("before-quit", () => engine?.close());

/**
 * Verificación automática (POS_SMOKE=1): carga la pantalla de verdad, comprueba que el puente IPC funciona de punta
 * a punta con la base SQLite y escribe el resultado en la salida estándar.
 */
type SmokeTools = {
  run: (js: string) => Promise<unknown>;
  sleep: (ms: number) => Promise<void>;
  shot: (name: string) => Promise<string>;
};

async function runSmoke() {
  const w = win!;
  const timeout = setTimeout(() => {
    console.log(JSON.stringify({ ok: false, error: "tiempo agotado" }));
    app.exit(1);
  }, process.env.POS_SCRIPT ? 120_000 : 30_000);
  w.webContents.on("render-process-gone", (_e, d) => {
    console.log(JSON.stringify({ ok: false, error: `renderer caído: ${d.reason}` }));
    app.exit(1);
  });
  w.webContents.once("did-finish-load", async () => {
    try {
      // Esperar a que React pinte algo y consultar el estado por el mismo puente que usa la interfaz.
      const result = await w.webContents.executeJavaScript(`
        (async () => {
          const screen = () => document.querySelector('[data-screen]')?.getAttribute('data-screen');
          for (let i = 0; i < 50 && (!screen() || screen() === 'loading'); i++) await new Promise(r => setTimeout(r, 100));
          const state = await window.pos.state();
          return {
            screen: document.querySelector('[data-screen]')?.getAttribute('data-screen') ?? null,
            bridge: Object.keys(window.pos).sort(),
            stage: state.stage,
            products: state.products,
            title: document.title,
          };
        })()`);
      // Escenario opcional (POS_SCRIPT): un módulo que maneja la pantalla real y puede sacar capturas.
      let scenario: unknown = undefined;
      if (process.env.POS_SCRIPT) {
        const mod = (await import(pathToFileURL(process.env.POS_SCRIPT).href)) as { default: (t: SmokeTools) => Promise<unknown> };
        scenario = await mod.default({
          run: (js) => w.webContents.executeJavaScript(js),
          sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
          shot: async (name) => {
            const dir = process.env.POS_SHOTS ?? app.getPath("temp");
            const file = join(dir, name + ".png");
            await mkdir(dir, { recursive: true });
            await writeFile(file, (await w.webContents.capturePage()).toPNG());
            return file;
          },
        });
      }
      clearTimeout(timeout);
      console.log(JSON.stringify({ ok: true, ...result, scenario }));
      app.exit(0);
    } catch (e) {
      console.log(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }));
      app.exit(1);
    }
  });
}
