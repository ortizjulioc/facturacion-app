/**
 * Cantidades en MILÉSIMAS (3 decimales): 1000n = 1.000 unidades.
 * Permite vender por peso (1.250 kg) sin usar floats.
 */
export type Milli = bigint;

/** Cantidad de una línea de venta: no negativa, hasta 3 decimales. */
export const toMilli = (quantity: string | number): Milli => {
  const text = typeof quantity === "number" ? quantity.toString() : quantity.trim();
  const m = /^(\d+)(?:\.(\d{1,3}))?$/.exec(text);
  if (!m) throw new Error(`Cantidad inválida: "${text}"`);
  const [, whole, frac = ""] = m;
  return BigInt(whole!) * 1000n + BigInt(frac.padEnd(3, "0"));
};

/** Igual que `toMilli` pero admite signo (ajustes de inventario: "-2.5"). */
export const toSignedMilli = (quantity: string | number): Milli => {
  const text = typeof quantity === "number" ? quantity.toString() : quantity.trim();
  const negative = text.startsWith("-");
  const value = toMilli(negative ? text.slice(1) : text);
  return negative ? -value : value;
};

/** "1250n" → "1.25"; admite negativos ("-0.5"). */
export const fromMilli = (milli: Milli): string => {
  const negative = milli < 0n;
  const abs = negative ? -milli : milli;
  const whole = abs / 1000n;
  const frac = (abs % 1000n).toString().padStart(3, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
};
