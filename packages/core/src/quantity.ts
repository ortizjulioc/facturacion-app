/**
 * Cantidades en MILÉSIMAS (3 decimales): 1000n = 1.000 unidades.
 * Permite vender por peso (1.250 kg) sin usar floats.
 */
export type Milli = bigint;

export const toMilli = (quantity: string | number): Milli => {
  const text = typeof quantity === "number" ? quantity.toString() : quantity.trim();
  const m = /^(\d+)(?:\.(\d{1,3}))?$/.exec(text);
  if (!m) throw new Error(`Cantidad inválida: "${text}"`);
  const [, whole, frac = ""] = m;
  return BigInt(whole!) * 1000n + BigInt(frac.padEnd(3, "0"));
};

export const fromMilli = (milli: Milli): string => {
  const whole = milli / 1000n;
  const frac = (milli % 1000n).toString().padStart(3, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
};
