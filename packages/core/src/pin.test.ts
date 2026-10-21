import { describe, expect, it } from "vitest";
import { hashPin, pinProblem, verifyPin } from "./pin";

describe("PIN de cajero", () => {
  it("acepta solo 4 a 6 dígitos que no sean repetidos ni secuencias", () => {
    for (const ok of ["1357", "2580", "908172", "0042"]) expect(pinProblem(ok), ok).toBeNull();
    for (const bad of ["", "123", "1234567", "12a4", "1111", "000000", "1234", "4321", "987654", " 1357"]) {
      expect(pinProblem(bad), bad).not.toBeNull();
    }
  });

  it("guarda un resumen con sal (el mismo PIN da resúmenes distintos) y lo verifica", async () => {
    const a = await hashPin("2580", { iterations: 1000 });
    const b = await hashPin("2580", { iterations: 1000 });
    expect(a).toMatch(/^pbkdf2\$sha256\$1000\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain("2580");
    expect(await verifyPin("2580", a)).toBe(true);
    expect(await verifyPin("2581", a)).toBe(false);
    expect(await verifyPin("", a)).toBe(false);
  });

  it("no lanza con resúmenes mal formados o de otro esquema", async () => {
    for (const junk of ["", "abc", "pbkdf2$sha256$x$a$b", "bcrypt$10$a$b$c", "pbkdf2$sha256$100$!!!$!!!", "pbkdf2$sha256$99999999999$QQ==$QQ=="]) {
      expect(await verifyPin("2580", junk), junk).toBe(false);
    }
  });

  it("rechaza crear el resumen de un PIN inválido", async () => {
    await expect(hashPin("1234")).rejects.toThrow(/secuencia/);
    await expect(hashPin("12")).rejects.toThrow(/4 a 6/);
  });
});
