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

export const formatDate = (iso: string | Date | null | undefined) =>
  iso
    ? new Intl.DateTimeFormat("es-DO", { dateStyle: "medium", timeZone: TZ }).format(
        new Date(iso),
      )
    : "—";

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
