import { describe, expect, it } from "vitest";
import { toCents } from "./money";
import {
  buyerErrors,
  CONSUMER_ID_THRESHOLD,
  formatEncf,
  isModificationCode,
  isModifier,
  parseEncf,
  remainingCredit,
} from "./ecf";

describe("e-NCF", () => {
  it("se arma con E + tipo + 10 dígitos (13 caracteres)", () => {
    expect(formatEncf("E31", 1n)).toBe("E310000000001");
    expect(formatEncf("E32", 1234n)).toBe("E320000001234");
    expect(formatEncf("E34", 9_999_999_999n)).toBe("E349999999999");
    expect(formatEncf("E31", 1n)).toHaveLength(13);
  });

  it("rechaza secuencias fuera de rango", () => {
    expect(() => formatEncf("E31", 0n)).toThrow();
    expect(() => formatEncf("E31", 10_000_000_000n)).toThrow();
  });

  it("ida y vuelta con parseEncf", () => {
    expect(parseEncf("E320000001234")).toEqual({ type: "E32", sequence: 1234n });
    expect(parseEncf(formatEncf("E33", 77n))).toEqual({ type: "E33", sequence: 77n });
  });

  it("parseEncf rechaza formatos inválidos", () => {
    for (const bad of ["", "E31", "B0100000001", "E350000000001", "E310000000000", "e310000000001", "E31000000000A"]) {
      expect(parseEncf(bad)).toBeNull();
    }
  });
});

describe("umbral y notas", () => {
  it("el umbral de identificación es RD$250,000.00", () => {
    expect(CONSUMER_ID_THRESHOLD).toBe(toCents("250000.00"));
  });

  it("reconoce los comprobantes modificadores", () => {
    expect(isModifier("E33")).toBe(true);
    expect(isModifier("E34")).toBe(true);
    expect(isModifier("E31")).toBe(false);
    expect(isModificationCode(3)).toBe(true);
    expect(isModificationCode(9)).toBe(false);
    expect(isModificationCode("3")).toBe(false);
  });

  it("calcula lo que queda por acreditar sin bajar de cero", () => {
    expect(remainingCredit(10000n, 2500n)).toBe(7500n);
    expect(remainingCredit(10000n, 10000n)).toBe(0n);
    expect(remainingCredit(10000n, 12000n)).toBe(0n);
  });
});

describe("buyerErrors", () => {
  const none = { docType: null, docNumber: null } as const;
  const rnc = { docType: "RNC", docNumber: "101001577" } as const;
  const cedula = { docType: "CEDULA", docNumber: "00112345678" } as const;

  it("E31 exige comprador con RNC", () => {
    expect(buyerErrors("E31", 1000n, none)).toHaveLength(1);
    expect(buyerErrors("E31", 1000n, cedula)).toHaveLength(1);
    expect(buyerErrors("E31", 1000n, rnc)).toEqual([]);
  });

  it("E32 por debajo del umbral no exige comprador", () => {
    expect(buyerErrors("E32", CONSUMER_ID_THRESHOLD - 1n, none)).toEqual([]);
  });

  it("E32 desde el umbral exige comprador identificado (RNC o cédula)", () => {
    expect(buyerErrors("E32", CONSUMER_ID_THRESHOLD, none)).toHaveLength(1);
    expect(buyerErrors("E32", CONSUMER_ID_THRESHOLD, cedula)).toEqual([]);
    expect(buyerErrors("E32", CONSUMER_ID_THRESHOLD, rnc)).toEqual([]);
  });

  it("las notas no validan comprador aquí", () => {
    expect(buyerErrors("E34", 999_999_999n, none)).toEqual([]);
    expect(buyerErrors("E33", 999_999_999n, none)).toEqual([]);
  });
});
