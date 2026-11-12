import { describe, expect, it } from "vitest";
import { formatDocument, formatTaxId, normalizeDocument, normalizeTaxId } from "./document";

describe("RNC del contribuyente (persona jurídica o física)", () => {
  it("acepta 9 dígitos o una cédula de 11, con o sin guiones", () => {
    expect(normalizeTaxId("1-01-00157-7")).toEqual({ ok: true, value: "101001577" });
    expect(normalizeTaxId("001-1234567-8")).toEqual({ ok: true, value: "00112345678" });
    expect(normalizeTaxId("1234567890").ok).toBe(false);
    expect(normalizeTaxId("12345678").ok).toBe(false);
    expect(normalizeTaxId("ABC").ok).toBe(false);
  });

  it("se muestra con el formato que corresponde a su largo", () => {
    expect(formatTaxId("101001577")).toBe("1-01-00157-7");
    expect(formatTaxId("00112345678")).toBe("001-1234567-8");
  });
});

describe("normalizeDocument", () => {
  it("RNC: acepta guiones y espacios, exige 9 dígitos", () => {
    expect(normalizeDocument("RNC", "1-01-00157-7")).toEqual({ ok: true, value: "101001577" });
    expect(normalizeDocument("RNC", " 101 001 577 ")).toEqual({ ok: true, value: "101001577" });
    expect(normalizeDocument("RNC", "12345678").ok).toBe(false);
    expect(normalizeDocument("RNC", "12345678A").ok).toBe(false);
  });

  it("cédula: exige 11 dígitos", () => {
    expect(normalizeDocument("CEDULA", "001-1234567-8")).toEqual({ ok: true, value: "00112345678" });
    expect(normalizeDocument("CEDULA", "1234567890").ok).toBe(false);
  });

  it("pasaporte: alfanumérico en mayúsculas", () => {
    expect(normalizeDocument("PASAPORTE", "ab 123456")).toEqual({ ok: true, value: "AB123456" });
    expect(normalizeDocument("PASAPORTE", "A1").ok).toBe(false);
    expect(normalizeDocument("PASAPORTE", "AB-12345").ok).toBe(false);
  });
});

describe("formatDocument", () => {
  it("da formato legible a RNC y cédula", () => {
    expect(formatDocument("RNC", "101001577")).toBe("1-01-00157-7");
    expect(formatDocument("CEDULA", "00112345678")).toBe("001-1234567-8");
    expect(formatDocument("PASAPORTE", "AB123456")).toBe("AB123456");
  });

  it("deja igual lo que no tiene el largo esperado", () => {
    expect(formatDocument("RNC", "123")).toBe("123");
  });
});
