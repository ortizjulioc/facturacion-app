import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UpdateState } from "../shared/api";
import { CHECK_EVERY_MS, feedUrlFor, UpdateManager, type UpdaterLike } from "./updates";

/** Un `electron-updater` de mentira: se le dice qué eventos emitir al revisar. */
class FakeUpdater extends EventEmitter {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  allowDowngrade = true;
  feeds: string[] = [];
  checks = 0;
  installed: unknown[][] = [];
  onCheck: () => Promise<void> | void = () => undefined;
  setFeedURL(o: { provider: "generic"; url: string }) {
    this.feeds.push(o.url);
  }
  async checkForUpdates() {
    this.checks++;
    await this.onCheck();
  }
  quitAndInstall(...args: unknown[]) {
    this.installed.push(args);
  }
}

function make(opts: { url?: string | null } = {}) {
  const updater = new FakeUpdater();
  const states: UpdateState[] = [];
  const m = new UpdateManager(updater as unknown as UpdaterLike, {
    currentVersion: "0.1.0",
    feedUrl: () => (opts.url === undefined ? "https://api.test/updates/caja" : opts.url),
    onChange: (s) => states.push(s),
    now: () => new Date("2026-10-24T12:00:00Z"),
  });
  return { updater, m, states };
}

afterEach(() => vi.useRealTimers());

describe("auto-actualización de la caja", () => {
  it("se configura para descargar sola e instalar al cerrar, sin permitir versiones anteriores", () => {
    const { updater, m } = make();
    expect(updater).toMatchObject({ autoDownload: true, autoInstallOnAppQuit: true, allowDowngrade: false });
    expect(m.state()).toMatchObject({ phase: "idle", current: "0.1.0", checkedAt: null, version: null });
  });

  it("sigue el ciclo: revisa, encuentra una versión, la descarga y queda lista", async () => {
    const { updater, m, states } = make();
    updater.onCheck = () => {
      updater.emit("checking-for-update");
      updater.emit("update-available", { version: "0.2.0" });
      updater.emit("download-progress", { percent: 37.4 });
      updater.emit("download-progress", { percent: 99.9 });
      updater.emit("update-downloaded", { version: "0.2.0" });
    };
    const end = await m.check();
    expect(end).toMatchObject({ phase: "ready", version: "0.2.0", percent: 100, current: "0.1.0" });
    expect(updater.feeds).toEqual(["https://api.test/updates/caja"]);
    expect(states.map((s) => [s.phase, s.percent])).toEqual([["checking", 0], ["downloading", 0], ["downloading", 37], ["downloading", 100], ["ready", 100]]);
    expect(states.filter((s) => s.phase === "downloading").every((s) => s.version === "0.2.0")).toBe(true);
  });

  it("sin versión nueva vuelve a reposo y anota la hora de la revisión", async () => {
    const { updater, m } = make();
    updater.onCheck = () => {
      updater.emit("checking-for-update");
      updater.emit("update-not-available");
    };
    expect(await m.check()).toMatchObject({ phase: "idle", checkedAt: "2026-10-24T12:00:00.000Z", version: null });
  });

  it("un error (sin internet, sin versiones publicadas) queda como aviso y la próxima revisión reintenta", async () => {
    const { updater, m } = make();
    updater.onCheck = () => {
      updater.emit("error", new Error("net::ERR_INTERNET_DISCONNECTED\n   at ..."));
    };
    expect(await m.check()).toMatchObject({ phase: "error", message: "net::ERR_INTERNET_DISCONNECTED" });
    updater.onCheck = () => {
      updater.emit("update-not-available");
    };
    expect(await m.check()).toMatchObject({ phase: "idle", message: null });
    expect(updater.checks).toBe(2);
    // Si el actualizador lanza sin emitir, también se anota.
    updater.onCheck = () => Promise.reject(new Error("boom"));
    expect(await m.check()).toMatchObject({ phase: "error", message: "boom" });
  });

  it("no repite una revisión en curso, ni revisa si ya hay una descarga lista o en marcha", async () => {
    const { updater, m } = make();
    let release: () => void = () => undefined;
    updater.onCheck = () => new Promise<void>((r) => (release = r));
    const [a, b] = [m.check(), m.check()];
    expect(updater.checks).toBe(1);
    release();
    await Promise.all([a, b]);

    updater.emit("update-available", { version: "0.3.0" });
    await m.check();
    expect(updater.checks).toBe(1); // descargando: no vuelve a preguntar
    updater.emit("update-downloaded", { version: "0.3.0" });
    await m.check();
    expect(updater.checks).toBe(1);
  });

  it("sin dirección de versiones (caja sin configurar) no consulta nada", async () => {
    const { updater, m } = make({ url: null });
    expect(await m.check()).toMatchObject({ phase: "idle", checkedAt: "2026-10-24T12:00:00.000Z" });
    expect(updater.checks).toBe(0);
    expect(updater.feeds).toEqual([]);
  });

  it("solo instala cuando la descarga está lista, y nunca por su cuenta", async () => {
    const { updater, m } = make();
    expect(m.installNow()).toBe(false);
    expect(updater.installed).toEqual([]);
    updater.emit("update-available", { version: "0.2.0" });
    expect(m.installNow()).toBe(false); // todavía descargando
    updater.emit("update-downloaded", { version: "0.2.0" });
    expect(updater.installed).toEqual([]); // lista pero esperando la orden del cajero
    expect(m.installNow()).toBe(true);
    expect(updater.installed).toEqual([[false, true]]); // con ventana, y se vuelve a abrir sola
  });

  it("revisa pasado el primer retraso y luego cada cuatro horas", async () => {
    vi.useFakeTimers();
    const { updater, m } = make();
    updater.onCheck = () => {
      updater.emit("update-not-available");
    };
    m.start(1000);
    m.start(1000); // iniciar dos veces no duplica
    await vi.advanceTimersByTimeAsync(999);
    expect(updater.checks).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(updater.checks).toBe(1);
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS);
    expect(updater.checks).toBe(2);
    m.stop();
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS * 2);
    expect(updater.checks).toBe(2);
  });
});

describe("dirección de las versiones", () => {
  it("sale del servidor al que está conectada la caja, o de POS_UPDATE_URL", () => {
    expect(feedUrlFor("https://api.miempresa.do/", undefined)).toBe("https://api.miempresa.do/updates/caja");
    expect(feedUrlFor("https://api.miempresa.do", "https://otro.example/caja/")).toBe("https://otro.example/caja");
    expect(feedUrlFor(null, undefined)).toBeNull();
    expect(feedUrlFor("no-es-una-url", undefined)).toBeNull();
    expect(feedUrlFor(null, "http://localhost:3001/updates/caja")).toBe("http://localhost:3001/updates/caja");
  });
});
