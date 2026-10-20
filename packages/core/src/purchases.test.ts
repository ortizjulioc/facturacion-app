import { describe, expect, it } from "vitest";
import {
  ALL_ECF_LABELS,
  ALL_ECF_TYPES,
  ECF_TYPES,
  formatEncf,
  parseEncf,
  PURCHASE_ECF_TYPES,
} from "./ecf";
import {
  DEFAULT_EXPENSE_TYPE,
  EXPENSE_TYPES,
  isExpenseType,
  normalizeSupplierNcf,
  retentionErrors,
  unitCostFromBase,
} from "./purchases";

describe("tipos de e-CF de compras", () => {
  it("E41 y E43 tienen secuencia propia pero no son tipos de venta", () => {
    expect(PURCHASE_ECF_TYPES).toEqual(["E41", "E43"]);
    expect((ECF_TYPES as readonly string[]).includes("E41")).toBe(false);
    expect(ALL_ECF_TYPES).toEqual(["E31", "E32", "E33", "E34", "E41", "E43"]);
    expect(ALL_ECF_LABELS.E41).toBe("Comprobante de compras");
    expect(ALL_ECF_LABELS.E43).toBe("Gastos menores");
  });

  it("formatea y lee e-NCF de compras", () => {
    expect(formatEncf("E41", 7n)).toBe("E410000000007");
    expect(formatEncf("E43", 1234n)).toBe("E430000001234");
    expect(parseEncf("E430000000009")).toEqual({ type: "E43", sequence: 9n });
    expect(parseEncf("E440000000001")).toBeNull();
  });
});

describe("tipos de gasto (606)", () => {
  it("son 11 y el de mercancía para la venta es el 9", () => {
    expect(Object.keys(EXPENSE_TYPES)).toHaveLength(11);
    expect(DEFAULT_EXPENSE_TYPE).toBe(9);
    expect(isExpenseType(9)).toBe(true);
    expect(isExpenseType(12)).toBe(false);
    expect(isExpenseType(0)).toBe(false);
    expect(isExpenseType("9")).toBe(false);
    expect(isExpenseType(2.5)).toBe(false);
  });
});

describe("normalizeSupplierNcf", () => {
  it("acepta serie B y e-NCF, ignorando espacios, guiones y minúsculas", () => {
    expect(normalizeSupplierNcf("B0100000123")).toBe("B0100000123");
    expect(normalizeSupplierNcf(" b01-0000 0123 ")).toBe("B0100000123");
    expect(normalizeSupplierNcf("E310000000045")).toBe("E310000000045");
  });

  it("rechaza longitudes y prefijos inválidos", () => {
    for (const bad of [
      "",
      "B010000012",
      "B01000001234",
      "E31000000004",
      "A0100000123",
      "B01000001AB",
      "12345678901",
    ]) {
      expect(normalizeSupplierNcf(bad), bad).toBeNull();
    }
  });
});

describe("unitCostFromBase", () => {
  it("divide la base entre la cantidad y redondea a centavos", () => {
    expect(unitCostFromBase(10_000n, 2_000n)).toBe(5_000n); // 100.00 / 2 = 50.00
    expect(unitCostFromBase(10_000n, 3_000n)).toBe(3_333n); // 33.33
    expect(unitCostFromBase(10_000n, 1_500n)).toBe(6_667n); // 100 / 1.5 = 66.67
    expect(unitCostFromBase(0n, 1_000n)).toBe(0n);
  });

  it("rechaza cantidades no positivas", () => {
    expect(() => unitCostFromBase(100n, 0n)).toThrow();
  });
});

describe("retentionErrors", () => {
  const base = { totalTax: 1_800n, subtotal: 10_000n };
  it("sin retenciones o dentro de los límites es válido", () => {
    expect(retentionErrors({ ...base, itbisWithheld: 0n, isrWithheld: 0n })).toEqual([]);
    expect(
      retentionErrors({ ...base, itbisWithheld: 1_800n, isrWithheld: 10_000n }),
    ).toEqual([]);
  });
  it("no permite superar el ITBIS ni el monto sin ITBIS", () => {
    expect(
      retentionErrors({ ...base, itbisWithheld: 1_801n, isrWithheld: 0n }),
    ).toHaveLength(1);
    expect(
      retentionErrors({ ...base, itbisWithheld: 0n, isrWithheld: 10_001n }),
    ).toHaveLength(1);
    expect(
      retentionErrors({ ...base, itbisWithheld: -1n, isrWithheld: 0n }),
    ).toHaveLength(1);
  });
});
