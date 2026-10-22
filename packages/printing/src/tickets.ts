import { ECF_LABELS, formatDop, toCents, type EcfType } from "@facturacion/core";
import type { CodePage } from "./encoding";
import { EscPos } from "./escpos";

/** Datos de un comprobante tal como los entrega la caja (misma forma que `Receipt` del motor). */
export type ReceiptData = {
  sale: { encf: string; type: "E31" | "E32" | "E34"; issuedAt: string; total: string; refundOf: string | null };
  company: { legalName: string; tradeName: string | null; rnc: string; address: string; phone: string | null } | null;
  buyerName: string | null;
  buyerDoc: string | null;
  lines: { name: string; quantity: string; unitPrice: string; total: string }[];
  totals: { subtotal: string; tax: string; propina: string; total: string };
  payments: { method: string; amount: string }[];
  cashierName: string | null;
  /**
   * Texto del código QR de la DGII. Solo existe cuando el comprobante ya está firmado (necesita el código de seguridad
   * de la firma): sin él no se imprime QR, para no entregar un código que la DGII no reconocería.
   */
  qr?: string | null;
  /** Código de seguridad de la firma (6 caracteres) y su fecha, para la representación impresa. */
  securityCode?: string | null;
  signedAt?: string | null;
};

/** Datos de un informe de turno (X o Z). */
export type ShiftData = {
  shift: { openedBy: { name: string | null }; openedAt: string; closedAt: string | null; notes: string | null };
  report: {
    documents: number;
    byType: Record<"E31" | "E32" | "E34", { count: number; total: string }>;
    sales: { subtotal: string; tax: string; propina: string; total: string };
    net: string;
    payments: Partial<Record<string, string>>;
    openingAmount: string;
    cashReceived: string;
    expectedCash: string;
    countedCash?: string;
    difference?: string;
  };
  company: ReceiptData["company"];
};

export type TicketOptions = {
  cols: number;
  codePage?: CodePage;
  /** Abre la gaveta al empezar a imprimir (ventas en efectivo). */
  openDrawer?: boolean;
  /** Corta el papel al final (por defecto sí). */
  cut?: boolean;
};

const METHOD: Record<string, string> = { CASH: "Efectivo", CARD: "Tarjeta", TRANSFER: "Transferencia", CHECK: "Cheque", OTHER: "Otro" };
const money = (v: string) => formatDop(toCents(v));

/** "21/10/2026 15:52" en hora de Santo Domingo, sin depender del idioma del sistema. */
export function formatDateTime(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Santo_Domingo",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("day")}/${get("month")}/${get("year")} ${get("hour")}:${get("minute")}`;
}

function header(p: EscPos, company: ReceiptData["company"]) {
  p.center();
  if (company) {
    p.bold().line(company.tradeName ?? company.legalName).bold(false);
    if (company.tradeName) p.line(company.legalName);
    p.line(`RNC ${company.rnc}`).paragraph(company.address, "center");
    if (company.phone) p.line(`Tel. ${company.phone}`);
  }
  p.left();
}

function begin(opts: TicketOptions) {
  const p = new EscPos({ cols: opts.cols, codePage: opts.codePage }).init();
  if (opts.openDrawer) p.openDrawer();
  return p;
}
function end(p: EscPos, opts: TicketOptions) {
  p.feed(opts.cut === false ? 4 : 3);
  if (opts.cut !== false) p.cut();
  return p.bytes();
}

/** Ticket de una venta o de una nota de crédito. */
export function receiptTicket(r: ReceiptData, opts: TicketOptions): Uint8Array {
  const p = begin(opts);
  const credit = r.sale.type === "E34";
  header(p, r.company);
  p.rule();
  p.center().bold().line(ECF_LABELS[r.sale.type as EcfType].toUpperCase()).bold(false);
  p.line(`e-NCF: ${r.sale.encf}`);
  if (credit && r.sale.refundOf) p.line(`Modifica: ${r.sale.refundOf}`);
  p.line(formatDateTime(r.sale.issuedAt)).left();
  if (r.buyerName) p.paragraph(`Cliente: ${r.buyerName}${r.buyerDoc ? ` (${r.buyerDoc})` : ""}`);
  p.rule();

  for (const l of r.lines) {
    p.columns(`${l.quantity} x ${l.name}`, money(l.total));
    if (l.quantity !== "1") p.line(`   ${money(l.unitPrice)} c/u`);
  }
  p.rule();
  p.columns("Subtotal", money(r.totals.subtotal));
  p.columns("ITBIS", money(r.totals.tax));
  if (Number(r.totals.propina) > 0) p.columns("Propina legal", money(r.totals.propina));
  p.bold().size(2);
  // En doble ancho caben la mitad de columnas.
  const half = Math.floor(p.cols / 2);
  const total = money(r.totals.total);
  p.line(`TOTAL`.padEnd(Math.max(1, half - total.length)) + total).size(1).bold(false);
  p.rule();
  if (credit) p.line("Reembolso:");
  for (const pay of r.payments) p.columns(METHOD[pay.method] ?? pay.method, money(pay.amount));
  if (r.cashierName) p.feed(1).line(`Atendió: ${r.cashierName}`);

  if (r.qr) {
    p.feed(1).center().qr(r.qr, opts.cols >= 40 ? 6 : 4).line("Escanee para verificar en la DGII");
    if (r.securityCode) p.line(`Código de seguridad: ${r.securityCode}`);
    if (r.signedAt) p.line(`Fecha de firma: ${formatDateTime(r.signedAt)}`);
    p.left();
  }
  if (!credit) p.feed(1).center().line("¡Gracias por su compra!").left();
  return end(p, opts);
}

/** Informe X (turno abierto) o Z (cerrado). */
export function shiftTicket(d: ShiftData, opts: TicketOptions): Uint8Array {
  const p = begin(opts);
  const closed = d.shift.closedAt !== null;
  header(p, d.company);
  p.rule().center().bold().size(2).line(closed ? "INFORME Z" : "INFORME X").size(1).bold(false).line(closed ? "Cierre de turno" : "Turno en curso").left();
  p.rule();
  p.line(`Abrió: ${d.shift.openedBy.name ?? "-"}`).line(`Apertura: ${formatDateTime(d.shift.openedAt)}`);
  if (d.shift.closedAt) p.line(`Cierre: ${formatDateTime(d.shift.closedAt)}`);
  p.rule();

  const labels = { E32: "Consumo", E31: "Crédito fiscal", E34: "Notas de crédito" } as const;
  for (const t of ["E32", "E31", "E34"] as const) {
    const row = d.report.byType[t];
    if (row.count > 0) p.columns(`${labels[t]} x ${row.count}`, `${t === "E34" ? "-" : ""}${money(row.total)}`);
  }
  if (d.report.documents === 0) p.line("Sin comprobantes");
  p.columns("Subtotal", money(d.report.sales.subtotal));
  p.columns("ITBIS", money(d.report.sales.tax));
  if (Number(d.report.sales.propina) > 0) p.columns("Propina legal", money(d.report.sales.propina));
  p.bold().columns("VENTAS NETAS", money(d.report.net)).bold(false);
  p.rule().line("Cobros (menos devoluciones)");
  for (const [method, amount] of Object.entries(d.report.payments)) {
    if (amount !== undefined) p.columns(METHOD[method] ?? method, money(amount));
  }
  p.rule();
  p.columns("Fondo", money(d.report.openingAmount));
  p.columns("Efectivo neto cobrado", money(d.report.cashReceived));
  p.bold().columns("Efectivo esperado", money(d.report.expectedCash)).bold(false);
  if (d.report.countedCash !== undefined) p.columns("Efectivo contado", money(d.report.countedCash));
  if (d.report.difference !== undefined) {
    const diff = Number(d.report.difference);
    p.bold().columns(diff === 0 ? "Cuadra" : diff > 0 ? "Sobran" : "Faltan", diff === 0 ? "" : money(Math.abs(diff).toFixed(2))).bold(false);
  }
  if (d.shift.notes) p.feed(1).paragraph(`Observaciones: ${d.shift.notes}`);
  if (closed) {
    p.feed(3).line("_".repeat(Math.floor(p.cols / 2) - 2) + "  " + "_".repeat(Math.floor(p.cols / 2) - 2));
    const half = Math.floor(p.cols / 2);
    p.line("Cajero".padEnd(half) + "Supervisor");
  }
  return end(p, opts);
}

/** Ticket de prueba: ancho, tildes, QR y corte (para comprobar la configuración de la impresora). */
export function testTicket(opts: TicketOptions): Uint8Array {
  const p = begin(opts);
  p.center().bold().size(2).line("PRUEBA").size(1).bold(false).line("Impresora configurada").left();
  p.rule();
  p.line("Ancho: " + opts.cols + " columnas");
  p.line("1234567890".repeat(Math.ceil(opts.cols / 10)).slice(0, opts.cols));
  p.line("áéíóú ÁÉÍÓÚ ñ Ñ ü Ü ¿? ¡! € °");
  p.columns("Izquierda", "Derecha");
  p.rule();
  p.center().qr("https://example.com/prueba", opts.cols >= 40 ? 6 : 4).line("QR de prueba").left();
  return end(p, opts);
}

/** Solo abre la gaveta (sin imprimir nada). */
export function drawerOnly(opts: Pick<TicketOptions, "cols" | "codePage">): Uint8Array {
  return new EscPos(opts).init().openDrawer().bytes();
}
