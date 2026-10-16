/**
 * Dinero en CENTAVOS (enteros). Nunca usar float para montos fiscales.
 * `bigint` para que no haya pérdida de precisión en sumas grandes ni en la BD (BigInt).
 */
export type Cents = bigint;

export const toCents = (amount: string): Cents => {
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(amount.trim());
  if (!m) throw new Error(`Monto inválido: "${amount}"`);
  const [, sign, whole, frac = ""] = m;
  const cents = BigInt(whole!) * 100n + BigInt(frac.padEnd(2, "0"));
  return sign === "-" ? -cents : cents;
};

export const fromCents = (cents: Cents): string => {
  const neg = cents < 0n;
  const abs = neg ? -cents : cents;
  const whole = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
};

/** "RD$ 1,234.50" */
export const formatDop = (cents: Cents): string => {
  const [whole, frac] = fromCents(cents).split(".") as [string, string];
  const neg = whole.startsWith("-");
  const digits = neg ? whole.slice(1) : whole;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}RD$ ${grouped}.${frac}`;
};
