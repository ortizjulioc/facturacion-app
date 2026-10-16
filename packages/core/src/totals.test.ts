import { describe, expect, it } from "vitest";
import { toCents } from "./money";
import { fromMilli, toMilli } from "./quantity";
import { divRound, TAX_CODES } from "./tax";
import { calculateDocument, calculateLine, type LineInput } from "./totals";

const line = (price: string, qty: string, tax: LineInput["tax"], rest: Partial<LineInput> = {}) =>
  calculateLine({ unitPrice: toCents(price), quantity: toMilli(qty), tax, ...rest });

describe("divRound", () => {
  it("redondea mitad hacia arriba", () => {
    expect(divRound(12500n, 1000n)).toBe(13n);
    expect(divRound(12499n, 1000n)).toBe(12n);
    expect(divRound(0n, 7n)).toBe(0n);
  });
  it("en negativos se aleja de cero y es simétrico", () => {
    expect(divRound(-25n, 10n)).toBe(-3n);
    expect(divRound(-24n, 10n)).toBe(-2n);
  });
  it("rechaza divisores no positivos", () => {
    expect(() => divRound(1n, 0n)).toThrow();
  });
});

describe("quantity", () => {
  it("convierte a milésimas y de vuelta", () => {
    expect(toMilli("1.5")).toBe(1500n);
    expect(toMilli("0.001")).toBe(1n);
    expect(toMilli(3)).toBe(3000n);
    expect(fromMilli(1250n)).toBe("1.25");
    expect(fromMilli(1000n)).toBe("1");
  });
  it("rechaza más de 3 decimales o formato inválido", () => {
    expect(() => toMilli("1.2345")).toThrow();
    expect(() => toMilli("-1")).toThrow();
    expect(() => toMilli("abc")).toThrow();
  });
});

describe("calculateLine · precio sin ITBIS", () => {
  it("ITBIS 18 %", () => {
    expect(line("100.00", "1", "ITBIS18")).toMatchObject({
      gross: 10000n,
      base: 10000n,
      taxAmount: 1800n,
      total: 11800n,
    });
  });

  it("ITBIS 16 %", () => {
    expect(line("100.00", "1", "ITBIS16").taxAmount).toBe(1600n);
  });

  it("exento y tasa cero no cobran impuesto", () => {
    expect(line("100.00", "2", "EXENTO")).toMatchObject({ taxAmount: 0n, total: 20000n });
    expect(line("100.00", "2", "ITBIS0")).toMatchObject({ taxAmount: 0n, total: 20000n });
  });

  it("redondea el ITBIS por línea (99.99 × 3 → 53.99)", () => {
    expect(line("99.99", "3", "ITBIS18")).toMatchObject({
      gross: 29997n,
      taxAmount: 5399n,
      total: 35396n,
    });
  });

  it("vende por peso: 1.250 kg × 80.00", () => {
    expect(line("80.00", "1.250", "EXENTO").gross).toBe(10000n);
  });

  it("redondea el importe bruto (0.25 × 0.500 = 0.13)", () => {
    expect(line("0.25", "0.5", "EXENTO").gross).toBe(13n);
  });

  it("descuento porcentual se resta antes del impuesto", () => {
    expect(
      line("100.00", "1", "ITBIS18", { discount: { type: "percent", bps: 1000 } }),
    ).toMatchObject({ discount: 1000n, base: 9000n, taxAmount: 1620n, total: 10620n });
  });

  it("descuento por monto", () => {
    expect(
      line("100.00", "1", "ITBIS18", { discount: { type: "amount", cents: 500n } }),
    ).toMatchObject({ base: 9500n, taxAmount: 1710n });
  });

  it("descuento del 100 % deja la línea en cero", () => {
    expect(
      line("100.00", "1", "ITBIS18", { discount: { type: "percent", bps: 10000 } }),
    ).toMatchObject({ base: 0n, taxAmount: 0n, total: 0n });
  });
});

describe("calculateLine · precio con ITBIS incluido", () => {
  it("118.00 con 18 % → base 100.00 e ITBIS 18.00", () => {
    expect(line("118.00", "1", "ITBIS18", { priceIncludesTax: true })).toMatchObject({
      base: 10000n,
      taxAmount: 1800n,
      total: 11800n,
    });
  });

  it("100.00 incluido: el total se conserva y el ITBIS absorbe el redondeo", () => {
    expect(line("100.00", "1", "ITBIS18", { priceIncludesTax: true })).toMatchObject({
      base: 8475n,
      taxAmount: 1525n,
      total: 10000n,
    });
  });

  it("el descuento se aplica sobre el precio con impuesto", () => {
    const r = line("118.00", "1", "ITBIS18", {
      priceIncludesTax: true,
      discount: { type: "percent", bps: 1000 },
    });
    expect(r.total).toBe(10620n);
    expect(r.base + r.taxAmount).toBe(r.total);
  });

  it("exento incluido no separa nada", () => {
    expect(line("50.00", "1", "EXENTO", { priceIncludesTax: true })).toMatchObject({
      base: 5000n,
      taxAmount: 0n,
    });
  });
});

describe("calculateLine · validaciones", () => {
  it("rechaza datos inválidos", () => {
    expect(() => line("-1.00", "1", "ITBIS18")).toThrow();
    expect(() => calculateLine({ unitPrice: 100n, quantity: 0n, tax: "ITBIS18" })).toThrow();
    expect(() =>
      line("10.00", "1", "ITBIS18", { discount: { type: "amount", cents: 1001n } }),
    ).toThrow();
    expect(() =>
      line("10.00", "1", "ITBIS18", { discount: { type: "percent", bps: 10001 } }),
    ).toThrow();
  });
});

describe("calculateDocument", () => {
  const lines: LineInput[] = [
    { unitPrice: toCents("100.00"), quantity: toMilli("1"), tax: "ITBIS18" },
    { unitPrice: toCents("50.00"), quantity: toMilli("1"), tax: "EXENTO" },
    { unitPrice: toCents("99.99"), quantity: toMilli("3"), tax: "ITBIS18" },
  ];

  it("agrupa bases e ITBIS por tasa", () => {
    const t = calculateDocument({ lines });
    expect(t.byTax.ITBIS18).toEqual({ base: 39997n, taxAmount: 7199n });
    expect(t.byTax.EXENTO).toEqual({ base: 5000n, taxAmount: 0n });
    expect(t.byTax.ITBIS16).toEqual({ base: 0n, taxAmount: 0n });
    expect(t).toMatchObject({ subtotal: 44997n, totalTax: 7199n, propinaLegal: 0n, total: 52196n });
  });

  it("propina legal = 10 % del subtotal sin ITBIS", () => {
    const t = calculateDocument({ lines, propinaLegal: true });
    expect(t.propinaLegal).toBe(4500n);
    expect(t.total).toBe(56696n);
  });

  it("suma los descuentos de todas las líneas", () => {
    const t = calculateDocument({
      lines: [
        { ...lines[0]!, discount: { type: "amount", cents: 1000n } },
        { ...lines[1]!, discount: { type: "percent", bps: 2000 } },
      ],
    });
    expect(t.totalDiscount).toBe(2000n);
  });

  it("rechaza documentos sin líneas", () => {
    expect(() => calculateDocument({ lines: [] })).toThrow();
  });
});

describe("invariantes (datos pseudoaleatorios, semilla fija)", () => {
  // LCG determinista para que un fallo sea reproducible.
  let seed = 123456789;
  const rand = (max: number) => {
    seed = (seed * 1664525 + 1013904223) % 2 ** 32;
    return seed % max;
  };

  const randomLine = (): LineInput => ({
    unitPrice: BigInt(rand(5_000_000)),
    quantity: BigInt(1 + rand(20_000)),
    tax: TAX_CODES[rand(TAX_CODES.length)]!,
    priceIncludesTax: rand(2) === 1,
    ...(rand(3) === 0
      ? { discount: { type: "percent" as const, bps: rand(10_001) } }
      : {}),
  });

  it("cada línea cuadra: base + ITBIS = total y nada es negativo", () => {
    for (let i = 0; i < 2000; i++) {
      const r = calculateLine(randomLine());
      expect(r.base + r.taxAmount).toBe(r.total);
      expect(r.base).toBeGreaterThanOrEqual(0n);
      expect(r.taxAmount).toBeGreaterThanOrEqual(0n);
      expect(r.discount).toBeLessThanOrEqual(r.gross);
    }
  });

  it("con ITBIS incluido, el total de la línea es exactamente bruto − descuento", () => {
    for (let i = 0; i < 1000; i++) {
      const input = { ...randomLine(), priceIncludesTax: true };
      const r = calculateLine(input);
      expect(r.total).toBe(r.gross - r.discount);
    }
  });

  it("el total del documento es la suma exacta de sus líneas (+ propina)", () => {
    for (let i = 0; i < 300; i++) {
      const n = 1 + rand(8);
      const t = calculateDocument({
        lines: Array.from({ length: n }, randomLine),
        propinaLegal: rand(2) === 1,
      });
      expect(t.total).toBe(t.lines.reduce((s, l) => s + l.total, 0n) + t.propinaLegal);
      const buckets = TAX_CODES.reduce((s, c) => s + t.byTax[c].base + t.byTax[c].taxAmount, 0n);
      expect(buckets + t.propinaLegal).toBe(t.total);
    }
  });
});
