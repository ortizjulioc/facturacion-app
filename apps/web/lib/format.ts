import { formatDop, toCents, type EcfType } from "@facturacion/core";

export const STATUS_LABELS: Record<string, string> = {
  DRAFT: "Borrador",
  ISSUED: "Emitida",
  SIGNED: "Firmada",
  SENT: "Enviada a la DGII",
  ACCEPTED: "Aceptada",
  ACCEPTED_CONDITIONAL: "Aceptada condicional",
  REJECTED: "Rechazada",
};

export const statusTone = (status: string): "neutral" | "success" | "warning" =>
  status === "DRAFT" ? "neutral" : status === "REJECTED" ? "warning" : "success";

export const PAYMENT_LABELS: Record<string, string> = {
  CASH: "Efectivo",
  TRANSFER: "Transferencia",
  CHECK: "Cheque",
  CARD: "Tarjeta",
  CREDIT: "Crédito",
  OTHER: "Otro",
};

export const PAYMENT_METHODS = Object.keys(PAYMENT_LABELS);

const TZ = "America/Santo_Domingo";

export const formatDateTime = (iso: string | Date | null | undefined) =>
  iso
    ? new Intl.DateTimeFormat("es-DO", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: TZ,
      }).format(new Date(iso))
    : "—";

/**
 * Fecha para mostrar. Un texto "AAAA-MM-DD" es un DÍA de calendario (fecha de un comprobante, vencimiento…),
 * no un instante: se muestra tal cual, sin pasarlo por la zona horaria (si no, retrocede un día).
 */
export const formatDate = (iso: string | Date | null | undefined) => {
  if (!iso) return "—";
  if (typeof iso === "string" && /^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    return new Intl.DateTimeFormat("es-DO", { dateStyle: "medium", timeZone: "UTC" }).format(
      new Date(`${iso}T00:00:00Z`),
    );
  }
  return new Intl.DateTimeFormat("es-DO", { dateStyle: "medium", timeZone: TZ }).format(new Date(iso));
};

/** La API devuelve montos como texto decimal; se formatean con el mismo código que el motor fiscal. */
export function money(value: string, currency = "DOP") {
  const text = formatDop(toCents(value));
  return currency === "USD" ? text.replace("RD$", "US$") : text;
}

export const isDebitCredit = (type: EcfType | string) => type === "E33" || type === "E34";

/** Fecha de hoy (AAAA-MM-DD) en hora de Santo Domingo. */
export const todayLocal = () =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: TZ }).format(new Date());

export const monthStartLocal = () => `${todayLocal().slice(0, 7)}-01`;

/** Cursos del servicio en mesa (se muestran solo cuando el restaurante usa más de uno). */
export const COURSE_LABELS: Record<number, string> = {
  1: "Entrada",
  2: "Plato fuerte",
  3: "Postre",
  4: "Curso 4",
  5: "Curso 5",
};
export const COURSES = [1, 2, 3, 4, 5];
