import { describe, expect, it } from "vitest";
import { PosEngine } from "./engine";

describe("impresora de la caja", () => {
  it("parte sin impresora, guarda lo que se configura (saneado) y lo conserva al reabrir", () => {
    const engine = PosEngine.open({ dbPath: ":memory:" });
    expect(engine.printerConfig()).toMatchObject({ mode: "none", paper: 80, autoPrint: true, drawerOnCash: true, port: 9100 });

    const saved = engine.savePrinterConfig({ mode: "network", host: " 192.168.1.50 ", port: 0, paper: 58, autoPrint: false });
    expect(saved).toMatchObject({ mode: "network", host: "192.168.1.50", port: 9100, paper: 58, autoPrint: false, drawerOnCash: true });
    expect(engine.printerConfig()).toEqual(saved);

    // Una configuración rara guardada (a mano o de una versión vieja) se sanea al leerla.
    engine.savePrinterConfig({ mode: "usb" as never, codePage: "x" as never });
    expect(engine.printerConfig()).toMatchObject({ mode: "none", codePage: "cp858" });
    engine.close();
  });
});
