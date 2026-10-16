import { describe, expect, it } from "vitest";
import { formatDocument, normalizeDocument } from "./document";

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
