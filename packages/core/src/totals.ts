import type { Cents } from "./money";
import type { Milli } from "./quantity";
import { divRound, PROPINA_LEGAL_BPS, TAX_CODES, TAX_RATE_BPS, type TaxCode } from "./tax";

export type Discount =
  | { type: "percent"; bps: number } // 1000 = 10 %
  | { type: "amount"; cents: Cents };

export type LineInput = {
  /** Precio unitario en centavos. Con `priceIncludesTax` ya incluye el impuesto. */
  unitPrice: Cents;
  quantity: Milli;
  tax: TaxCode;
  discount?: Discount;
  priceIncludesTax?: boolean;
};

export type LineResult = {
  tax: TaxCode;
  /** unitPrice × cantidad, antes de descuento. */
  gross: Cents;
  discount: Cents;
  /** Base imponible (monto del ítem sin impuesto, ya con descuento). */
  base: Cents;
  taxAmount: Cents;
  /** base + impuesto. */
  total: Cents;
};

export type TaxBucket = { base: Cents; taxAmount: Cents };

export type DocumentTotals = {
  lines: LineResult[];
  /** Desglose por tasa: coincide con los grupos de montos del e-CF. */
  byTax: Record<TaxCode, TaxBucket>;
  totalDiscount: Cents;
  /** Suma de bases imponibles (sin ITBIS ni propina). */
  subtotal: Cents;
  totalTax: Cents;
  propinaLegal: Cents;
  /** subtotal + ITBIS + propina legal. */
  total: Cents;
};

export type DocumentInput = {
  lines: LineInput[];
  /** Restaurantes: añade 10 % de propina legal sobre el subtotal (sin ITBIS). */
  propinaLegal?: boolean;
};

const BPS = 10_000n;

/**
 * Calcula una línea. El impuesto se redondea POR LÍNEA (mitad hacia arriba), y los totales del
 * documento son la suma exacta de las líneas, de modo que lo impreso siempre cuadra.
 */
export function calculateLine(input: LineInput): LineResult {
  const { unitPrice, quantity, tax, priceIncludesTax = false } = input;
  if (unitPrice < 0n) throw new Error("El precio no puede ser negativo");
  if (quantity <= 0n) throw new Error("La cantidad debe ser mayor que cero");

  const gross = divRound(unitPrice * quantity, 1000n);
  const discount = resolveDiscount(gross, input.discount);
  const afterDiscount = gross - discount;
  const rate = BigInt(TAX_RATE_BPS[tax]);

  if (priceIncludesTax) {
    // El total de la línea ya trae el impuesto: se separa la base y el resto es ITBIS.
    const base = divRound(afterDiscount * BPS, BPS + rate);
    return { tax, gross, discount, base, taxAmount: afterDiscount - base, total: afterDiscount };
  }

  const taxAmount = divRound(afterDiscount * rate, BPS);
  return {
    tax,
    gross,
    discount,
    base: afterDiscount,
    taxAmount,
    total: afterDiscount + taxAmount,
  };
}

function resolveDiscount(gross: Cents, discount?: Discount): Cents {
  if (!discount) return 0n;
  if (discount.type === "percent") {
    if (!Number.isInteger(discount.bps) || discount.bps < 0 || discount.bps > 10_000) {
      throw new Error("El descuento porcentual debe estar entre 0 y 100 %");
    }
    return divRound(gross * BigInt(discount.bps), BPS);
  }
  if (discount.cents < 0n || discount.cents > gross) {
    throw new Error("El descuento no puede ser negativo ni mayor que el monto de la línea");
  }
  return discount.cents;
}

export function calculateDocument(input: DocumentInput): DocumentTotals {
  if (input.lines.length === 0) throw new Error("El documento necesita al menos una línea");

  const lines = input.lines.map(calculateLine);
  const byTax = Object.fromEntries(
    TAX_CODES.map((code) => [code, { base: 0n, taxAmount: 0n }]),
  ) as Record<TaxCode, TaxBucket>;

  let totalDiscount = 0n;
  for (const line of lines) {
    byTax[line.tax].base += line.base;
    byTax[line.tax].taxAmount += line.taxAmount;
    totalDiscount += line.discount;
  }

  const subtotal = lines.reduce((sum, l) => sum + l.base, 0n);
  const totalTax = lines.reduce((sum, l) => sum + l.taxAmount, 0n);
  const propinaLegal = input.propinaLegal ? divRound(subtotal * BigInt(PROPINA_LEGAL_BPS), BPS) : 0n;

  return {
    lines,
    byTax,
    totalDiscount,
    subtotal,
    totalTax,
    propinaLegal,
    total: subtotal + totalTax + propinaLegal,
  };
}
