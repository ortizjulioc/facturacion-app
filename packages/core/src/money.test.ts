import { describe, expect, it } from "vitest";
import { convertCents, formatDop, fromCents, toCents } from "./money";

describe("money", () => {
  it("convierte texto a centavos sin errores de float", () => {
    expect(toCents("0.1")).toBe(10n);
    expect(toCents("19.99")).toBe(1999n);
    expect(toCents("1000")).toBe(100000n);
    expect(toCents("-5.5")).toBe(-550n);
  });

  it("rechaza montos con más de 2 decimales o formato inválido", () => {
    expect(() => toCents("1.234")).toThrow();
    expect(() => toCents("abc")).toThrow();
  });

  it("ida y vuelta", () => {
    for (const v of ["0.00", "0.05", "12.30", "999999999.99", "-0.01"]) {
      expect(fromCents(toCents(v))).toBe(v);
    }
  });

  it("formatea pesos dominicanos", () => {
    expect(formatDop(123450n)).toBe("RD$ 1,234.50");
    expect(formatDop(-5n)).toBe("-RD$ 0.05");
  });
});

describe("convertCents", () => {
  it("convierte con la tasa de cambio y redondea a centavos", () => {
    expect(convertCents(1000n, "58.5")).toBe(58_500n);
    expect(convertCents(1000n, "1")).toBe(1000n);
    expect(convertCents(333n, "58.7325")).toBe(19_558n); // 3.33 × 58.7325 = 195.58
    expect(convertCents(0n, "60")).toBe(0n);
  });
  it("rechaza tasas inválidas", () => {
    expect(() => convertCents(1n, "abc")).toThrow();
    expect(() => convertCents(1n, "1.23456")).toThrow();
    expect(() => convertCents(1n, "-2")).toThrow();
  });
});
