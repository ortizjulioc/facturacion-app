import type { Cents } from "./money";
import { divRound } from "./tax";

/**
 * Tipo de bienes y servicios comprados, tal como lo pide el formato 606 de la DGII.
 * (Verifica con tu contador si la DGII actualiza el catálogo.)
 */
export const EXPENSE_TYPES = {
  1: "Gastos de personal",
  2: "Trabajos, suministros y servicios",
  3: "Arrendamientos",
  4: "Gastos de activos fijos",
  5: "Gastos de representación",
  6: "Otras deducciones admitidas",
  7: "Gastos financieros",
  8: "Gastos extraordinarios",
  9: "Compras y gastos que forman parte del costo de venta",
  10: "Adquisiciones de activos",
  11: "Gastos de seguros",
} as const;
export type ExpenseType = keyof typeof EXPENSE_TYPES;
export const isExpenseType = (v: unknown): v is ExpenseType =>
  typeof v === "number" && Number.isInteger(v) && v in EXPENSE_TYPES;

/** Compras de mercancía para vender: es el tipo por defecto cuando hay inventario. */
export const DEFAULT_EXPENSE_TYPE: ExpenseType = 9;

/**
 * NCF que entrega un proveedor: serie B (`B01…`, 11 caracteres) o e-NCF (`E31…`, 13 caracteres).
 * Devuelve el NCF normalizado (mayúsculas, sin espacios ni guiones) o null si no tiene formato válido.
 */
export function normalizeSupplierNcf(raw: string): string | null {
  const value = raw.replace(/[\s-]/g, "").toUpperCase();
  return /^(B\d{10}|E\d{12})$/.test(value) ? value : null;
}

/**
 * Costo unitario NETO (sin impuesto) de una línea de compra: base imponible ÷ cantidad,
 * redondeado a centavos. Es el costo que se guarda en inventario.
 */
export function unitCostFromBase(base: Cents, quantityMilli: bigint): Cents {
  if (quantityMilli <= 0n) throw new Error("La cantidad debe ser mayor que cero");
  return divRound(base * 1000n, quantityMilli);
}

/**
 * Retenciones practicadas al proveedor (E41 y facturas de proveedor). Devuelve mensajes de error.
 *  - El ITBIS retenido no puede superar el ITBIS facturado.
 *  - El ISR retenido no puede superar el monto facturado sin ITBIS.
 */
export function retentionErrors(input: {
  totalTax: Cents;
  subtotal: Cents;
  itbisWithheld: Cents;
  isrWithheld: Cents;
}): string[] {
  const errors: string[] = [];
  if (input.itbisWithheld < 0n || input.isrWithheld < 0n) {
    errors.push("Las retenciones no pueden ser negativas");
  }
  if (input.itbisWithheld > input.totalTax) {
    errors.push("El ITBIS retenido no puede superar el ITBIS de la compra");
  }
  if (input.isrWithheld > input.subtotal) {
    errors.push("El ISR retenido no puede superar el monto de la compra sin ITBIS");
  }
  return errors;
}
