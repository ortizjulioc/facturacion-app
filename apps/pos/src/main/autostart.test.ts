import { describe, expect, it } from "vitest";
import { AutoStart } from "./autostart";

function make(supported = true, initialized = false) {
  const os = { openAtLogin: false, writes: 0 };
  const flag = { value: initialized };
  const a = new AutoStart(
    {
      getLoginItemSettings: () => ({ openAtLogin: os.openAtLogin }),
      setLoginItemSettings: (s) => ((os.openAtLogin = s.openAtLogin), os.writes++),
    },
    { supported, initialized: { read: () => flag.value, write: () => (flag.value = true) } },
  );
  return { a, os, flag };
}

describe("abrir la caja con el sistema", () => {
  it("la primera vez que corre la caja instalada queda activado", () => {
    const { a, os, flag } = make();
    expect(a.state()).toEqual({ supported: true, enabled: false });
    expect(a.applyDefault()).toEqual({ supported: true, enabled: true });
    expect(os.openAtLogin).toBe(true);
    expect(flag.value).toBe(true);
  });

  it("después respeta la decisión del usuario: ni al reiniciar ni al actualizar se vuelve a activar", () => {
    const { a, os } = make();
    a.applyDefault();
    expect(a.set(false)).toEqual({ supported: true, enabled: false });
    a.applyDefault(); // otro arranque, p. ej. tras una actualización
    expect(a.state().enabled).toBe(false);
    expect(os.writes).toBe(2); // el valor por omisión y el cambio; el segundo arranque no escribió nada
    expect(a.set(true).enabled).toBe(true);
  });

  it("si la caja ya estaba configurada antes (valor inicializado), no toca el sistema", () => {
    const { a, os } = make(true, true);
    expect(a.applyDefault().enabled).toBe(false);
    expect(os.writes).toBe(0);
  });

  it("refleja lo que diga el sistema (p. ej. si lo quitan desde «Aplicaciones de inicio»)", () => {
    const { a, os } = make();
    a.applyDefault();
    os.openAtLogin = false;
    expect(a.state().enabled).toBe(false);
  });

  it("en desarrollo o en un sistema sin esa función no hace nada", () => {
    const { a, os, flag } = make(false);
    expect(a.applyDefault()).toEqual({ supported: false, enabled: false });
    expect(a.set(true)).toEqual({ supported: false, enabled: false });
    expect(os.writes).toBe(0);
    expect(flag.value).toBe(false);
  });
});
