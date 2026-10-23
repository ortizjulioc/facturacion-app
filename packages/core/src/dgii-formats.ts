import { fromCents, type Cents } from "./money";

/**
 * Formatos de envío de datos de la DGII: 606 (compras), 607 (ventas) y 608 (comprobantes anulados), según los
 * instructivos publicados en dgii.gov.do (Norma General 07-2018 y 05-2019; 606 al 12-02-2026, 607 de dic-2025, 608 de
 * mar-2026). Cada uno es un archivo de texto: una línea de encabezado y una línea por registro, con los campos separados
 * por `|`.
 *
 * Lo que dicen los instructivos (campos, orden, valores permitidos, longitudes, límites) está aquí tal cual. Lo que NO
 * dicen —la disposición exacta del archivo de texto: encabezado `606|RNC|AAAAMM|cantidad`, separador `|`, códigos con
 * dos dígitos, montos con punto y dos decimales— sale de lo que genera la plantilla de Excel de la DGII; hay que
 * comprobarlo con su «Herramienta de Pre-validación» antes de enviar.
 */

export type FormatCode = 606 | 607 | 608;

/** Registros máximos por archivo (encabezado de cada instructivo). */
export const FORMAT_MAX_RECORDS: Record<FormatCode, number> = { 606: 10_000, 607: 65_000, 608: 4_999 };

/** Una observación sobre un registro (o sobre el archivo, con `ref` = "Archivo"). */
export type FormatIssue = { ref: string; message: string };

export type FormatFile = {
  format: FormatCode;
  /** `DGII_F_606_<RNC>_<AAAAMM>.TXT` */
  filename: string;
  text: string;
  count: number;
  /** Si hay errores no se debe enviar: la DGII lo rechazaría. */
  errors: FormatIssue[];
};

// ───────────── Catálogos (valores permitidos de los instructivos) ─────────────

/** 606: «Tipo de Retención en ISR». */
export const ISR_WITHHOLDING_TYPES = {
  1: "Alquileres",
  2: "Honorarios por servicios",
  3: "Otras rentas",
  4: "Otras rentas (rentas presuntas)",
  5: "Intereses pagados a personas jurídicas residentes",
  6: "Intereses pagados a personas físicas residentes",
  7: "Retención por proveedores del Estado",
  8: "Juegos telefónicos",
  9: "Retenciones subsector de ganadería de carne bovina",
} as const;
export type IsrWithholdingType = keyof typeof ISR_WITHHOLDING_TYPES;
export const isIsrWithholdingType = (v: unknown): v is IsrWithholdingType =>
  typeof v === "number" && Number.isInteger(v) && v in ISR_WITHHOLDING_TYPES;

/** 606: «Forma de Pago». */
export const PAYMENT_FORMS_606 = {
  1: "Efectivo",
  2: "Cheques/Transferencias/Depósito",
  3: "Tarjeta crédito/débito",
  4: "Compra a crédito",
  5: "Permuta",
  6: "Notas de crédito",
  7: "Mixto",
} as const;

/** 607: «Tipo de Ingreso». */
export const INCOME_TYPES = {
  1: "Ingresos por operaciones (No financieros)",
  2: "Ingresos Financieros",
  3: "Ingresos Extraordinarios",
  4: "Ingresos por Arrendamientos",
  5: "Ingresos por Venta de Activo Depreciable",
  6: "Otros Ingresos",
} as const;

/** 608: «Tipo de Anulación». */
export const ANNULMENT_TYPES = {
  1: "Deterioro de factura preimpresa",
  2: "Errores de impresión (factura preimpresa)",
  3: "Impresión defectuosa",
  4: "Corrección de la información",
  5: "Cambio de productos",
  6: "Devolución de productos",
  7: "Omisión de productos",
  8: "Errores en secuencia de NCF",
  9: "Por cese de operaciones",
  10: "Pérdida o hurto de talonarios",
} as const;
export type AnnulmentType = keyof typeof ANNULMENT_TYPES;

/** 606 y 607: «Tipo de identificación» (1 RNC, 2 cédula; en el 607 también 3 pasaporte o ID tributaria). */
export type IdType = 1 | 2 | 3;

/**
 * Desde julio 2018 (Norma General 10-18) las facturas de consumo se informan en el 607 solo si llegan a este monto
 * (en centavos); las menores van en el «Resumen General de Facturas de Consumo» de la Oficina Virtual.
 */
export const CONSUMER_INVOICE_LISTING_THRESHOLD: Cents = 25_000_000n;

// ───────────── Utilidades ─────────────

const pad2 = (n: number) => String(n).padStart(2, "0");
/** Importe con punto decimal y dos decimales: 1234.50 */
const amount = (c: Cents) => fromCents(c);
/** Importe opcional: vacío si es cero. */
const optional = (c: Cents) => (c === 0n ? "" : fromCents(c));
/** AAAA-MM-DD → AAAAMMDD */
const ymd = (iso: string) => iso.replaceAll("-", "");

/** RNC (9 dígitos) o cédula (11): solo dígitos. */
export const digitsOnly = (v: string | null | undefined) => (v ?? "").replace(/\D/g, "");

/** NCF o e-NCF como lo acepta el formato: 11 (serie B) o 13 caracteres (e-NCF); 19 solo para comprobantes de antes de mayo 2018. */
const NCF = /^([A-Z]\d{10}|[A-Z]\d{12}|[A-Z0-9]{19})$/;

function headerErrors(format: FormatCode, rnc: string, period: string, count: number): FormatIssue[] {
  const issues: FormatIssue[] = [];
  const id = digitsOnly(rnc);
  if (id.length !== 9 && id.length !== 11) issues.push({ ref: "Archivo", message: "El RNC o cédula de quien remite debe tener 9 u 11 dígitos" });
  const m = /^(\d{4})(\d{2})$/.exec(period);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) issues.push({ ref: "Archivo", message: "El período debe ser AAAAMM (año y mes)" });
  if (count > FORMAT_MAX_RECORDS[format]) {
    issues.push({ ref: "Archivo", message: `El formato ${format} admite hasta ${FORMAT_MAX_RECORDS[format].toLocaleString("en-US")} registros y este tiene ${count.toLocaleString("en-US")}: divídelo en períodos más cortos` });
  }
  return issues;
}

function assemble(format: FormatCode, rnc: string, period: string, lines: string[][], errors: FormatIssue[]): FormatFile {
  const id = digitsOnly(rnc);
  const head = [String(format), id, period, String(lines.length)].join("|");
  const text = [head, ...lines.map((l) => l.join("|"))].join("\r\n") + "\r\n";
  return {
    format,
    filename: `DGII_F_${format}_${id}_${period}.TXT`,
    text,
    count: lines.length,
    errors: [...headerErrors(format, rnc, period, lines.length), ...errors],
  };
}

// ───────────── 606: compras de bienes y servicios ─────────────

export type Row606 = {
  /** Cómo reconocer el registro en los mensajes (p. ej. el NCF y el proveedor). */
  ref: string;
  /** RNC o cédula del proveedor; vacío solo en gastos menores. */
  supplierId: string;
  idType: 1 | 2 | null;
  /** Tipo de bienes y servicios comprados (1–11). */
  expenseType: number;
  ncf: string;
  modifiedNcf: string | null;
  /** AAAA-MM-DD */
  date: string;
  paymentDate: string | null;
  services: Cents;
  goods: Cents;
  itbis: Cents;
  itbisWithheld: Cents;
  itbisProportional: Cents;
  itbisToCost: Cents;
  isrType: number | null;
  isrWithheld: Cents;
  selective: Cents;
  otherTaxes: Cents;
  tip: Cents;
  /** 1–7, ver `PAYMENT_FORMS_606`. */
  paymentForm: number;
};

/** Problemas de un registro del 606, con las reglas de los instructivos. */
export function check606(r: Row606): string[] {
  const e: string[] = [];
  if (!NCF.test(r.ncf)) e.push("El NCF debe tener 11 o 13 caracteres (p. ej. B0100000001 o E310000000001)");
  if (r.modifiedNcf && !NCF.test(r.modifiedNcf)) e.push("El NCF modificado debe tener 11 o 13 caracteres");
  const id = digitsOnly(r.supplierId);
  if (id === "") {
    if (!/^(B13|E43)/.test(r.ncf)) e.push("Falta el RNC o la cédula del proveedor (solo los gastos menores van sin ella)");
  } else if (r.idType === 1 && id.length !== 9) e.push("El RNC del proveedor debe tener 9 dígitos");
  else if (r.idType === 2 && id.length !== 11) e.push("La cédula del proveedor debe tener 11 dígitos");
  else if (r.idType === null) e.push("No se sabe si el documento del proveedor es RNC o cédula");
  if (r.expenseType < 1 || r.expenseType > 11) e.push("El tipo de bienes y servicios debe estar entre 1 y 11");
  if ((r.itbisWithheld > 0n || r.isrWithheld > 0n) && !r.paymentDate) e.push("Con retenciones hace falta la fecha de pago");
  if (r.isrWithheld > 0n && !isIsrWithholdingType(r.isrType)) e.push("Con retención de renta hay que indicar el tipo de retención en ISR");
  if (r.isrType !== null && r.isrWithheld === 0n) e.push("Hay un tipo de retención en ISR pero no hay monto retenido");
  if (r.paymentDate && r.paymentDate < r.date) e.push("La fecha de pago no puede ser anterior a la del comprobante");
  if (r.itbisToCost > r.itbis) e.push("El ITBIS llevado al costo no puede superar el ITBIS facturado");
  if (r.itbisToCost + r.itbisProportional > r.itbis) e.push("El ITBIS al costo y el sujeto a proporcionalidad no pueden sumar más que el ITBIS facturado");
  if (r.itbisWithheld > r.itbis) e.push("El ITBIS retenido no puede superar el ITBIS facturado");
  if (!(r.paymentForm in PAYMENT_FORMS_606)) e.push("Forma de pago inválida");
  const money = [r.services, r.goods, r.itbis, r.itbisWithheld, r.itbisProportional, r.itbisToCost, r.isrWithheld, r.selective, r.otherTaxes, r.tip];
  if (money.some((v) => v < 0n)) e.push("Los montos no pueden ser negativos");
  return e;
}

export function build606(input: { rnc: string; period: string; rows: Row606[] }): FormatFile {
  const errors: FormatIssue[] = [];
  const lines = input.rows.map((r) => {
    for (const message of check606(r)) errors.push({ ref: r.ref, message });
    const total = r.services + r.goods;
    return [
      digitsOnly(r.supplierId),
      r.idType === null ? "" : String(r.idType),
      pad2(r.expenseType),
      r.ncf,
      r.modifiedNcf ?? "",
      ymd(r.date),
      r.paymentDate ? ymd(r.paymentDate) : "",
      amount(r.services),
      amount(r.goods),
      amount(total),
      amount(r.itbis),
      optional(r.itbisWithheld),
      optional(r.itbisProportional),
      optional(r.itbisToCost),
      amount(r.itbis - r.itbisToCost), // ITBIS por adelantar: ITBIS facturado menos el llevado al costo
      "", // ITBIS percibido en compras: sin régimen vigente
      r.isrType === null ? "" : pad2(r.isrType),
      optional(r.isrWithheld),
      "", // ISR percibido en compras: sin régimen vigente
      optional(r.selective),
      optional(r.otherTaxes),
      optional(r.tip),
      pad2(r.paymentForm),
    ];
  });
  return assemble(606, input.rnc, input.period, lines, errors);
}

// ───────────── 607: ventas de bienes y servicios ─────────────

export type Row607 = {
  ref: string;
  buyerId: string;
  idType: IdType | null;
  ncf: string;
  /** NCF afectado por una nota de débito o de crédito. */
  modifiedNcf: string | null;
  /** Ver `INCOME_TYPES`. */
  incomeType: number;
  date: string;
  withholdingDate: string | null;
  /** Monto facturado, sin impuestos. */
  billed: Cents;
  itbis: Cents;
  itbisWithheldByThirds: Cents;
  isrWithheldByThirds: Cents;
  selective: Cents;
  otherTaxes: Cents;
  tip: Cents;
  /** Con impuestos; deben sumar el total del comprobante. */
  cash: Cents;
  bankTransfer: Cents;
  card: Cents;
  credit: Cents;
  giftVouchers: Cents;
  swap: Cents;
  otherForms: Cents;
};

/** Total del comprobante: lo facturado más ITBIS, selectivo, otros impuestos y propina. */
export const total607 = (r: Row607): Cents => r.billed + r.itbis + r.selective + r.otherTaxes + r.tip;
const paid607 = (r: Row607): Cents => r.cash + r.bankTransfer + r.card + r.credit + r.giftVouchers + r.swap + r.otherForms;

export function check607(r: Row607): string[] {
  const e: string[] = [];
  if (!NCF.test(r.ncf)) e.push("El NCF debe tener 11 o 13 caracteres (p. ej. B0100000001 o E310000000001)");
  if (r.modifiedNcf && !NCF.test(r.modifiedNcf)) e.push("El NCF modificado debe tener 11 o 13 caracteres");
  const id = digitsOnly(r.buyerId);
  if (id === "") e.push("Falta el RNC, la cédula o el pasaporte del comprador");
  else if (r.idType === 1 && id.length !== 9) e.push("El RNC del comprador debe tener 9 dígitos");
  else if (r.idType === 2 && id.length !== 11) e.push("La cédula del comprador debe tener 11 dígitos");
  else if (r.idType === null) e.push("No se sabe si el documento del comprador es RNC, cédula o pasaporte");
  if (!(r.incomeType in INCOME_TYPES)) e.push("Tipo de ingreso inválido");
  if ((r.itbisWithheldByThirds > 0n || r.isrWithheldByThirds > 0n) && !r.withholdingDate) e.push("Con retenciones hace falta la fecha de retención");
  if (r.itbisWithheldByThirds > r.itbis) e.push("El ITBIS retenido por el comprador no puede superar el ITBIS facturado");
  if (r.isrWithheldByThirds > r.billed) e.push("La retención de renta no puede superar el monto facturado");
  if (r.withholdingDate && r.withholdingDate < r.date) e.push("La fecha de retención no puede ser anterior al comprobante");
  if (paid607(r) !== total607(r)) e.push(`Las formas de pago (${amount(paid607(r))}) no suman el total del comprobante (${amount(total607(r))})`);
  const money = [r.billed, r.itbis, r.itbisWithheldByThirds, r.isrWithheldByThirds, r.selective, r.otherTaxes, r.tip, r.cash, r.bankTransfer, r.card, r.credit, r.giftVouchers, r.swap, r.otherForms];
  if (money.some((v) => v < 0n)) e.push("Los montos no pueden ser negativos");
  return e;
}

export function build607(input: { rnc: string; period: string; rows: Row607[] }): FormatFile {
  const errors: FormatIssue[] = [];
  const lines = input.rows.map((r) => {
    for (const message of check607(r)) errors.push({ ref: r.ref, message });
    return [
      digitsOnly(r.buyerId),
      r.idType === null ? "" : String(r.idType),
      r.ncf,
      r.modifiedNcf ?? "",
      pad2(r.incomeType),
      ymd(r.date),
      r.withholdingDate ? ymd(r.withholdingDate) : "",
      amount(r.billed),
      amount(r.itbis),
      optional(r.itbisWithheldByThirds),
      "", // ITBIS percibido: sin régimen vigente
      optional(r.isrWithheldByThirds),
      "", // ISR percibido: sin régimen vigente
      optional(r.selective),
      optional(r.otherTaxes),
      optional(r.tip),
      optional(r.cash),
      optional(r.bankTransfer),
      optional(r.card),
      optional(r.credit),
      optional(r.giftVouchers),
      optional(r.swap),
      optional(r.otherForms),
    ];
  });
  return assemble(607, input.rnc, input.period, lines, errors);
}

// ───────────── 608: comprobantes anulados ─────────────

export type Row608 = {
  ref: string;
  ncf: string;
  /** Fecha en que se emitió (o se anuló, si el número nunca se usó). */
  date: string;
  type: number;
};

export function check608(r: Row608): string[] {
  const e: string[] = [];
  if (!NCF.test(r.ncf)) e.push("El NCF debe tener 11 o 13 caracteres");
  if (!(r.type in ANNULMENT_TYPES)) e.push("Tipo de anulación inválido (1 a 10)");
  return e;
}

export function build608(input: { rnc: string; period: string; rows: Row608[] }): FormatFile {
  const errors: FormatIssue[] = [];
  const lines = input.rows.map((r) => {
    for (const message of check608(r)) errors.push({ ref: r.ref, message });
    return [r.ncf, ymd(r.date), pad2(r.type)];
  });
  return assemble(608, input.rnc, input.period, lines, errors);
}

/** Primer y último día (AAAA-MM-DD) de un período AAAAMM; null si no es válido. */
export function periodBounds(period: string): { from: string; to: string } | null {
  const m = /^(\d{4})(\d{2})$/.exec(period);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { from: `${m[1]}-${m[2]}-01`, to: `${m[1]}-${m[2]}-${pad2(last)}` };
}
