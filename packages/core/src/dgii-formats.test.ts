import { describe, expect, it } from "vitest";
import {
  ANNULMENT_TYPES,
  build606,
  build607,
  build608,
  check606,
  check607,
  FORMAT_MAX_RECORDS,
  periodBounds,
  type Row606,
  type Row607,
} from "./dgii-formats";

const row606 = (over: Partial<Row606> = {}): Row606 => ({
  ref: "B0100000001 · Proveedor SRL",
  supplierId: "101-00157-7",
  idType: 1,
  expenseType: 2,
  ncf: "B0100000001",
  modifiedNcf: null,
  date: "2026-10-05",
  paymentDate: "2026-10-05",
  services: 100_000n,
  goods: 0n,
  itbis: 18_000n,
  itbisWithheld: 0n,
  itbisProportional: 0n,
  itbisToCost: 0n,
  isrType: null,
  isrWithheld: 0n,
  selective: 0n,
  otherTaxes: 0n,
  tip: 0n,
  paymentForm: 1,
  ...over,
});

const row607 = (over: Partial<Row607> = {}): Row607 => ({
  ref: "E310000000001",
  buyerId: "131246301",
  idType: 1,
  ncf: "E310000000001",
  modifiedNcf: null,
  incomeType: 1,
  date: "2026-10-12",
  withholdingDate: null,
  billed: 100_000n,
  itbis: 18_000n,
  itbisWithheldByThirds: 0n,
  isrWithheldByThirds: 0n,
  selective: 0n,
  otherTaxes: 0n,
  tip: 0n,
  cash: 118_000n,
  bankTransfer: 0n,
  card: 0n,
  credit: 0n,
  giftVouchers: 0n,
  swap: 0n,
  otherForms: 0n,
  ...over,
});

describe("606: compras", () => {
  it("arma el archivo con encabezado y 23 campos por registro, en el orden del instructivo", () => {
    const f = build606({ rnc: "130-00000-1", period: "202610", rows: [row606()] });
    expect(f.errors).toEqual([]);
    expect(f.filename).toBe("DGII_F_606_130000001_202610.TXT");
    const [head, line, rest] = f.text.split("\r\n");
    expect(head).toBe("606|130000001|202610|1");
    expect(rest).toBe("");
    const cols = line!.split("|");
    expect(cols).toHaveLength(23);
    expect(cols).toEqual([
      "101001577", "1", "02", "B0100000001", "", "20261005", "20261005",
      "1000.00", "0.00", "1000.00", "180.00", "", "", "", "180.00", "", "", "", "", "", "", "", "01",
    ]);
  });

  it("separa servicios y bienes, suma el total y calcula el ITBIS por adelantar", () => {
    const f = build606({ rnc: "130000001", period: "202610", rows: [row606({ services: 50_000n, goods: 70_000n, itbis: 21_600n, itbisToCost: 3_000n })] });
    const c = f.text.split("\r\n")[1]!.split("|");
    expect(c.slice(7, 10)).toEqual(["500.00", "700.00", "1200.00"]);
    expect(c[10]).toBe("216.00");
    expect(c[13]).toBe("30.00"); // ITBIS llevado al costo
    expect(c[14]).toBe("186.00"); // por adelantar = facturado − costo
  });

  it("las retenciones piden fecha de pago y el tipo de retención de ISR", () => {
    const ok = row606({ itbisWithheld: 13_500n, isrWithheld: 10_000n, isrType: 2 });
    expect(check606(ok)).toEqual([]);
    const f = build606({ rnc: "130000001", period: "202610", rows: [ok] });
    const c = f.text.split("\r\n")[1]!.split("|");
    expect(c[11]).toBe("135.00");
    expect(c[16]).toBe("02");
    expect(c[17]).toBe("100.00");

    expect(check606(row606({ itbisWithheld: 1n, paymentDate: null }))).toContain("Con retenciones hace falta la fecha de pago");
    expect(check606(row606({ isrWithheld: 5_000n, isrType: null }))).toContain("Con retención de renta hay que indicar el tipo de retención en ISR");
    expect(check606(row606({ isrType: 3 }))).toContain("Hay un tipo de retención en ISR pero no hay monto retenido");
  });

  it("valida el NCF, el documento del proveedor y las fechas", () => {
    expect(check606(row606({ ncf: "B01-1" }))[0]).toMatch(/NCF/);
    expect(check606(row606({ ncf: "E310000000123" }))).toEqual([]); // e-NCF de 13
    expect(check606(row606({ supplierId: "123", idType: 1 }))).toContain("El RNC del proveedor debe tener 9 dígitos");
    expect(check606(row606({ supplierId: "40212345678", idType: 2 }))).toEqual([]);
    expect(check606(row606({ supplierId: "4021234567", idType: 2 }))).toContain("La cédula del proveedor debe tener 11 dígitos");
    expect(check606(row606({ supplierId: "", idType: null }))).toContain("Falta el RNC o la cédula del proveedor (solo los gastos menores van sin ella)");
    expect(check606(row606({ supplierId: "", idType: null, ncf: "E430000000009" }))).toEqual([]); // gasto menor
    expect(check606(row606({ paymentDate: "2026-10-01" }))).toContain("La fecha de pago no puede ser anterior a la del comprobante");
    expect(check606(row606({ expenseType: 12 }))).toContain("El tipo de bienes y servicios debe estar entre 1 y 11");
    expect(check606(row606({ itbisToCost: 20_000n }))).toContain("El ITBIS llevado al costo no puede superar el ITBIS facturado");
  });

  it("junta los errores con el registro al que pertenecen, y avisa si se pasa del máximo", () => {
    const f = build606({ rnc: "123", period: "2026-10", rows: [row606({ ncf: "X" }), row606()] });
    expect(f.errors.filter((e) => e.ref !== "Archivo")).toHaveLength(1);
    expect(f.errors.map((e) => e.message)).toEqual(
      expect.arrayContaining(["El RNC o cédula de quien remite debe tener 9 u 11 dígitos", "El período debe ser AAAAMM (año y mes)"]),
    );
    const many = build606({ rnc: "130000001", period: "202610", rows: Array.from({ length: FORMAT_MAX_RECORDS[606] + 1 }, () => row606()) });
    expect(many.errors.some((e) => e.message.includes("admite hasta 10,000"))).toBe(true);
  });

  it("sin compras el archivo es solo el encabezado en cero", () => {
    const f = build606({ rnc: "130000001", period: "202610", rows: [] });
    expect(f.text).toBe("606|130000001|202610|0\r\n");
    expect(f.errors).toEqual([]);
  });
});

describe("607: ventas", () => {
  it("arma el archivo con 23 campos, con los montos de pago solo donde hay", () => {
    const f = build607({ rnc: "130000001", period: "202610", rows: [row607({ cash: 58_000n, card: 60_000n })] });
    expect(f.errors).toEqual([]);
    expect(f.filename).toBe("DGII_F_607_130000001_202610.TXT");
    const [head, line] = f.text.split("\r\n");
    expect(head).toBe("607|130000001|202610|1");
    const c = line!.split("|");
    expect(c).toHaveLength(23);
    expect(c).toEqual([
      "131246301", "1", "E310000000001", "", "01", "20261012", "",
      "1000.00", "180.00", "", "", "", "", "", "", "", "580.00", "", "600.00", "", "", "", "",
    ]);
  });

  it("las formas de pago deben sumar el total (monto + ITBIS + selectivo + otros + propina)", () => {
    expect(check607(row607({ tip: 11_800n, cash: 118_000n }))[0]).toMatch(/no suman el total/);
    expect(check607(row607({ tip: 11_800n, cash: 129_800n }))).toEqual([]);
    expect(check607(row607({ cash: 0n, credit: 118_000n }))).toEqual([]);
  });

  it("nota de crédito: lleva el NCF que modifica; con retenciones pide fecha de retención", () => {
    const nc = row607({ ncf: "E340000000001", modifiedNcf: "E310000000001" });
    const c = build607({ rnc: "130000001", period: "202610", rows: [nc] }).text.split("\r\n")[1]!.split("|");
    expect(c[2]).toBe("E340000000001");
    expect(c[3]).toBe("E310000000001");
    expect(check607(row607({ itbisWithheldByThirds: 100n }))).toContain("Con retenciones hace falta la fecha de retención");
    expect(check607(row607({ isrWithheldByThirds: 100n, withholdingDate: "2026-10-20" }))).toEqual([]);
  });

  it("exige el documento del comprador y su tipo (RNC, cédula o pasaporte)", () => {
    expect(check607(row607({ buyerId: "", idType: null }))).toContain("Falta el RNC, la cédula o el pasaporte del comprador");
    expect(check607(row607({ buyerId: "AB123456", idType: 3 }))).toEqual([]); // el pasaporte solo se mide por su tipo
    expect(check607(row607({ buyerId: "12345", idType: 1 }))).toContain("El RNC del comprador debe tener 9 dígitos");
  });
});

describe("608: anulados", () => {
  it("arma el archivo con NCF, fecha y tipo de anulación de dos dígitos", () => {
    const f = build608({ rnc: "130000001", period: "202610", rows: [{ ref: "a", ncf: "E310000000007", date: "2026-10-03", type: 8 }, { ref: "b", ncf: "B0100000009", date: "2026-10-04", type: 10 }] });
    expect(f.errors).toEqual([]);
    expect(f.text).toBe("608|130000001|202610|2\r\nE310000000007|20261003|08\r\nB0100000009|20261004|10\r\n");
    expect(f.filename).toBe("DGII_F_608_130000001_202610.TXT");
  });

  it("valida NCF y tipo, y el máximo de 4,999 registros", () => {
    const bad = build608({ rnc: "130000001", period: "202610", rows: [{ ref: "x", ncf: "123", date: "2026-10-03", type: 11 }] });
    expect(bad.errors.map((e) => e.message)).toEqual(["El NCF debe tener 11 o 13 caracteres", "Tipo de anulación inválido (1 a 10)"]);
    expect(Object.keys(ANNULMENT_TYPES)).toHaveLength(10);
    const many = build608({ rnc: "130000001", period: "202610", rows: Array.from({ length: 5_000 }, (_, i) => ({ ref: String(i), ncf: `E31${String(i + 1).padStart(10, "0")}`, date: "2026-10-03", type: 8 })) });
    expect(many.errors.some((e) => e.message.includes("admite hasta 4,999"))).toBe(true);
  });
});

describe("retenciones e ITBIS al costo", () => {
  it("606: el ITBIS al costo y por proporcionalidad no pueden pasar del ITBIS, y el retenido tampoco", () => {
    expect(check606(row606({ itbisToCost: 10_000n, itbisProportional: 8_000n }))).toEqual([]);
    expect(check606(row606({ itbisToCost: 10_000n, itbisProportional: 8_001n }))).toContain(
      "El ITBIS al costo y el sujeto a proporcionalidad no pueden sumar más que el ITBIS facturado",
    );
    expect(check606(row606({ itbisWithheld: 18_001n }))).toContain("El ITBIS retenido no puede superar el ITBIS facturado");
    const c = build606({ rnc: "130000001", period: "202610", rows: [row606({ itbisToCost: 5_000n, itbisProportional: 3_000n })] }).text.split("\r\n")[1]!.split("|");
    expect(c.slice(10, 15)).toEqual(["180.00", "", "30.00", "50.00", "130.00"]);
  });

  it("607: las retenciones del comprador no pueden pasar de lo facturado y su fecha no puede ser anterior al comprobante", () => {
    const ok = row607({ itbisWithheldByThirds: 18_000n, isrWithheldByThirds: 10_000n, withholdingDate: "2026-10-20" });
    expect(check607(ok)).toEqual([]);
    const c = build607({ rnc: "130000001", period: "202610", rows: [ok] }).text.split("\r\n")[1]!.split("|");
    expect([c[6], c[9], c[11]]).toEqual(["20261020", "180.00", "100.00"]);
    expect(check607({ ...ok, itbisWithheldByThirds: 18_001n })).toContain("El ITBIS retenido por el comprador no puede superar el ITBIS facturado");
    expect(check607({ ...ok, isrWithheldByThirds: 100_001n })).toContain("La retención de renta no puede superar el monto facturado");
    expect(check607({ ...ok, withholdingDate: "2026-10-01" })).toContain("La fecha de retención no puede ser anterior al comprobante");
  });
});

describe("períodos", () => {
  it("da el primer y el último día del mes", () => {
    expect(periodBounds("202610")).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(periodBounds("202602")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(periodBounds("202402")).toEqual({ from: "2024-02-01", to: "2024-02-29" });
    expect(periodBounds("202613")).toBeNull();
    expect(periodBounds("2026-10")).toBeNull();
  });
});
