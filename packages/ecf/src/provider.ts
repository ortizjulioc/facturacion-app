/**
 * Todo lo que el sistema necesita de «quien habla con la DGII». La aplicación depende de esta interfaz, no de un
 * proveedor concreto: hoy la implementa `DgiiClient` (conexión directa) y mañana puede implementarla un proveedor
 * certificado, sin tocar el resto del sistema.
 */

/** Estado de validación de un comprobante en la DGII. */
export type FiscalStatus = "NOT_FOUND" | "ACCEPTED" | "REJECTED" | "IN_PROCESS" | "ACCEPTED_CONDITIONAL";

/** Código numérico del servicio de consulta de resultado → estado. */
export const FISCAL_STATUS_BY_CODE: Record<number, FiscalStatus> = {
  0: "NOT_FOUND",
  1: "ACCEPTED",
  2: "REJECTED",
  3: "IN_PROCESS",
  4: "ACCEPTED_CONDITIONAL",
};

/** Etiquetas para mostrar al usuario. */
export const FISCAL_STATUS_LABELS: Record<FiscalStatus, string> = {
  NOT_FOUND: "No encontrado",
  ACCEPTED: "Aceptado",
  REJECTED: "Rechazado",
  IN_PROCESS: "En proceso",
  ACCEPTED_CONDITIONAL: "Aceptado condicional",
};

/** ¿El comprobante tiene validez fiscal? (aceptado, con o sin condición). */
export const isFiscallyValid = (s: FiscalStatus) => s === "ACCEPTED" || s === "ACCEPTED_CONDITIONAL";

/** ¿Ya no va a cambiar? (si no, hay que volver a consultar más tarde). */
export const isFinalStatus = (s: FiscalStatus) => s !== "IN_PROCESS";

export type FiscalMessage = { code: string; text: string };

export type SubmitInput = {
  /** El e-CF ya firmado (`SignedEcf.xml`). */
  xml: string;
  /** RNC del emisor y e-NCF: forman el nombre del archivo que pide la DGII (`RNC + e-NCF`.xml). */
  rnc: string;
  encf: string;
};

export type SubmitResult = {
  /** Acuse de recibo con el que se consulta el resultado. */
  trackId: string;
};

export type TrackResult = {
  trackId: string;
  status: FiscalStatus;
  /** Código numérico tal como lo entrega la DGII. */
  code: number;
  /** Texto del estado tal como lo entrega la DGII. */
  statusText: string;
  rnc: string | null;
  encf: string | null;
  /**
   * `true` = el e-NCF quedó gastado aunque el comprobante se rechazó (no se puede reutilizar);
   * `false` = el rechazo fue por un defecto que no consume el número y se puede volver a emitir con él.
   */
  sequenceUsed: boolean | null;
  receivedAt: string | null;
  messages: FiscalMessage[];
};

/** Respuesta de la DGII a un resumen de factura de consumo (RFCE): llega en el mismo envío, sin TrackId. */
export type SummaryResult = {
  status: FiscalStatus;
  code: number;
  statusText: string;
  rnc: string | null;
  encf: string | null;
  sequenceUsed: boolean | null;
  messages: FiscalMessage[];
};

/** Un contribuyente electrónico del directorio de la DGII y los servicios (hosts) donde recibe. */
export type DirectoryEntry = { name: string; rnc: string; receptionUrl: string | null; approvalUrl: string | null; authenticationUrl: string | null };

/** Respuesta de la DGII a una aprobación comercial. */
export type ApprovalResult = { approved: boolean; status: string; code: string; messages: string[] };

/** Respuesta de la DGII a una anulación de rangos de e-NCF. */
export type AnnulmentResult = {
  /** true = todos los rangos quedaron anulados. */
  annulled: boolean;
  code: string;
  name: string;
  messages: string[];
};

export type TrackSummary = { trackId: string; status: FiscalStatus; statusText: string; receivedAt: string | null };

export interface FiscalProvider {
  /** Envía un e-CF firmado. Devuelve el TrackId (acuse de recibo) o lanza `FiscalError`. */
  submit(input: SubmitInput): Promise<SubmitResult>;
  /** Estado de validación de un envío. */
  result(trackId: string): Promise<TrackResult>;
  /**
   * Envía el resumen (RFCE) de una factura de consumo menor a RD$250,000. La DGII responde en el acto
   * (aceptado, aceptado condicional o rechazado).
   */
  submitSummary(input: SubmitInput): Promise<SummaryResult>;
  /** Estado de un resumen ya enviado, por RNC, e-NCF y código de seguridad. */
  summaryResult(rnc: string, encf: string, securityCode: string): Promise<SummaryResult>;
  /** Entrega a la DGII la copia de una aprobación o rechazo comercial (ACECF firmado). */
  submitApproval(input: SubmitInput): Promise<ApprovalResult>;
  /** Servicios de recepción y aprobación de un contribuyente electrónico (null si no está en el directorio). */
  directoryOf(rnc: string): Promise<DirectoryEntry | null>;
  /** Anula en la DGII rangos de e-NCF sin usar (ANECF firmado). Lanza `FiscalError` si los rechaza. */
  annulRanges(input: { xml: string; rnc: string; firstEncf: string }): Promise<AnnulmentResult>;
  /** Todos los envíos que la DGII tiene de un e-NCF (puede haber varios si se reenvió). */
  trackIdsOf(rnc: string, encf: string): Promise<TrackSummary[]>;
}

/**
 * Fallo al hablar con la DGII. `retryable` dice si tiene sentido reintentar el mismo envío (sin red, servidor caído,
 * límite de uso) o si es un rechazo definitivo de la solicitud que hay que corregir.
 */
export class FiscalError extends Error {
  override name = "FiscalError";
  constructor(
    message: string,
    readonly kind: "network" | "auth" | "rejected" | "server" | "config",
    readonly status: number | null = null,
  ) {
    super(message);
  }
  get retryable() {
    return this.kind === "network" || this.kind === "server";
  }
}
