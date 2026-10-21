import type { CodePage } from "./encoding";

/** Cómo se llega a la impresora: por su nombre en Windows (impresora instalada) o por red (puerto 9100). */
export type PrinterMode = "none" | "windows" | "network";

/** Configuración de la impresora de esta caja (se guarda en la base local). */
export type PrinterConfig = {
  mode: PrinterMode;
  /** Nombre de la impresora instalada en Windows (modo `windows`). */
  name: string;
  /** Dirección y puerto de la impresora de red (modo `network`; casi todas usan 9100). */
  host: string;
  port: number;
  /** Papel: 80 mm → 48 columnas; 58 mm → 32 columnas. */
  paper: 80 | 58;
  codePage: CodePage;
  /** Imprime el ticket solo al terminar cada venta o devolución. */
  autoPrint: boolean;
  /** Abre la gaveta cuando el cobro incluye efectivo. */
  drawerOnCash: boolean;
};

export const DEFAULT_PRINTER: PrinterConfig = {
  mode: "none",
  name: "",
  host: "",
  port: 9100,
  paper: 80,
  codePage: "cp858",
  autoPrint: true,
  drawerOnCash: true,
};

export const colsOf = (paper: PrinterConfig["paper"]) => (paper === 58 ? 32 : 48);

/** Completa y sanea una configuración que viene de afuera (base local o pantalla). */
export function normalizePrinterConfig(input: Partial<PrinterConfig> | null | undefined): PrinterConfig {
  const c = { ...DEFAULT_PRINTER, ...(input ?? {}) };
  return {
    mode: c.mode === "windows" || c.mode === "network" ? c.mode : "none",
    name: String(c.name ?? "").trim().slice(0, 200),
    host: String(c.host ?? "").trim().slice(0, 253),
    port: Number.isInteger(c.port) && c.port > 0 && c.port < 65536 ? c.port : 9100,
    paper: c.paper === 58 ? 58 : 80,
    codePage: c.codePage === "cp437" || c.codePage === "cp850" ? c.codePage : "cp858",
    autoPrint: c.autoPrint !== false,
    drawerOnCash: c.drawerOnCash !== false,
  };
}

/** ¿Falta algo para poder imprimir? Devuelve el motivo o null. */
export function printerProblem(c: PrinterConfig): string | null {
  if (c.mode === "none") return "No hay una impresora configurada";
  if (c.mode === "windows" && !c.name) return "Elige la impresora";
  if (c.mode === "network" && !c.host) return "Escribe la dirección de la impresora";
  return null;
}
