import type { Cents } from "./money";

/**
 * Impuestos del e-CF dominicano que maneja el motor.
 * Cada código corresponde a un grupo de montos del comprobante (gravado 18 %, 16 %, 0 %, exento).
 */
export const TAX_CODES = ["ITBIS18", "ITBIS16", "ITBIS0", "EXENTO"] as const;
export type TaxCode = (typeof TAX_CODES)[number];

/** Tasa en puntos básicos: 1800 = 18.00 %. */
export const TAX_RATE_BPS: Record<TaxCode, number> = {
  ITBIS18: 1800,
  ITBIS16: 1600,
  ITBIS0: 0,
  EXENTO: 0,
};

export const TAX_LABELS: Record<TaxCode, string> = {
  ITBIS18: "ITBIS 18 %",
  ITBIS16: "ITBIS 16 %",
  ITBIS0: "ITBIS tasa 0 %",
  EXENTO: "Exento",
};

export const isTaxCode = (v: unknown): v is TaxCode =>
  typeof v === "string" && (TAX_CODES as readonly string[]).includes(v);

/** Propina legal (Ley 16-92): 10 % del consumo, no gravada con ITBIS. */
export const PROPINA_LEGAL_BPS = 1000;

/** División entera con redondeo "mitad hacia arriba" (alejándose de cero en negativos). */
export function divRound(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error("El divisor debe ser positivo");
  const negative = numerator < 0n;
  const abs = negative ? -numerator : numerator;
  const q = abs / denominator;
  const r = abs % denominator;
  const rounded = r * 2n >= denominator ? q + 1n : q;
  return negative ? -rounded : rounded;
}
