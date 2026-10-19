import type { Cents } from "./money";
import type { DocumentType } from "./document";

/** Tipos de comprobante electrónico que el sistema emite hoy (el resto llega en fases posteriores). */
export const ECF_TYPES = ["E31", "E32", "E33", "E34"] as const;
export type EcfType = (typeof ECF_TYPES)[number];

export const ECF_LABELS: Record<EcfType, string> = {
  E31: "Factura de crédito fiscal",
  E32: "Factura de consumo",
  E33: "Nota de débito",
  E34: "Nota de crédito",
};

/** Las notas de débito y crédito modifican un comprobante ya emitido. */
export const isModifier = (type: EcfType) => type === "E33" || type === "E34";

/** Código de modificación del e-CF (campo CodigoModificacion de las notas). */
export const MODIFICATION_CODES = {
  1: "Anula el comprobante modificado",
  2: "Corrige el texto del comprobante modificado",
  3: "Corrige los montos del comprobante modificado",
  4: "Reemplaza un comprobante emitido en contingencia",
  5: "Referencia a una factura de consumo electrónica",
} as const;
export type ModificationCode = keyof typeof MODIFICATION_CODES;
export const isModificationCode = (v: unknown): v is ModificationCode =>
  typeof v === "number" && v in MODIFICATION_CODES;

/**
 * A partir de RD$250,000.00 una factura de consumo debe identificar al comprador
 * (Norma General 10-2018 de la DGII). En centavos.
 */
export const CONSUMER_ID_THRESHOLD: Cents = 25_000_000n;

const MAX_SEQUENCE = 9_999_999_999n;

/**
 * e-NCF = "E" + tipo (2 dígitos) + secuencia (10 dígitos): E310000000001 (13 caracteres).
 */
export function formatEncf(type: EcfType, sequence: bigint): string {
  if (sequence < 1n || sequence > MAX_SEQUENCE) {
    throw new Error("La secuencia del e-NCF debe estar entre 1 y 9,999,999,999");
  }
  return `E${type.slice(1)}${sequence.toString().padStart(10, "0")}`;
}

export function parseEncf(encf: string): { type: EcfType; sequence: bigint } | null {
  const m = /^E(31|32|33|34)(\d{10})$/.exec(encf);
  if (!m) return null;
  const sequence = BigInt(m[2]!);
  if (sequence < 1n) return null;
  return { type: `E${m[1]}` as EcfType, sequence };
}

export type BuyerInput = {
  docType: DocumentType | null;
  docNumber: string | null;
};

/**
 * Reglas sobre el comprador al emitir. Devuelve una lista de mensajes (vacía = válido).
 *  - E31 (crédito fiscal): el comprador debe tener RNC.
 *  - E32 (consumo) de RD$250,000 o más: el comprador debe estar identificado.
 *  - Notas (E33/E34): el comprador se hereda del comprobante modificado, no se valida aquí.
 */
export function buyerErrors(type: EcfType, total: Cents, buyer: BuyerInput): string[] {
  const identified = Boolean(buyer.docType && buyer.docNumber);
  if (type === "E31" && !(buyer.docType === "RNC" && buyer.docNumber)) {
    return ["La factura de crédito fiscal requiere un cliente con RNC"];
  }
  if (type === "E32" && total >= CONSUMER_ID_THRESHOLD && !identified) {
    return ["Las facturas de consumo desde RD$250,000.00 requieren identificar al comprador"];
  }
  return [];
}

/** Monto que aún se puede acreditar sobre un comprobante, dadas las notas de crédito ya emitidas. */
export function remainingCredit(originalTotal: Cents, alreadyCredited: Cents): Cents {
  const left = originalTotal - alreadyCredited;
  return left > 0n ? left : 0n;
}
