import type { UpdateState } from "../shared/api";

/** Lo que se usa de `electron-updater` (así se prueba sin Electron). */
export type UpdaterLike = {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowDowngrade: boolean;
  setFeedURL(options: { provider: "generic"; url: string }): void;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(event: "checking-for-update", cb: () => void): unknown;
  on(event: "update-available", cb: (info: { version: string }) => void): unknown;
  on(event: "update-not-available", cb: () => void): unknown;
  on(event: "download-progress", cb: (p: { percent: number }) => void): unknown;
  on(event: "update-downloaded", cb: (info: { version: string }) => void): unknown;
  on(event: "error", cb: (e: Error) => void): unknown;
};

export type UpdateOptions = {
  currentVersion: string;
  /** Dirección donde la API publica las versiones (la lee en cada revisión: puede cambiar si se reconfigura la caja). */
  feedUrl: () => string | null;
  /** Avisa cada vez que cambia el estado (la pantalla lo muestra). */
  onChange: (state: UpdateState) => void;
  now?: () => Date;
};

/** Cada cuánto se busca una versión nueva. */
export const CHECK_EVERY_MS = 4 * 60 * 60_000;

/**
 * Auto-actualización de la caja. Busca una versión nueva al arrancar y cada cuatro horas, la **descarga en segundo plano**
 * y se instala al cerrar el programa. Nunca reinicia sola: una caja en plena venta no se puede interrumpir, así que
 * la instalación inmediata es una orden del cajero («Reiniciar y actualizar»).
 *
 * Los errores (sin internet, servidor sin publicar versiones) no molestan: se guardan en el estado y la próxima revisión
 * lo vuelve a intentar.
 */
export class UpdateManager {
  private current: UpdateState;
  private timer: NodeJS.Timeout | null = null;
  private checking: Promise<UpdateState> | null = null;

  constructor(
    private readonly updater: UpdaterLike,
    private readonly opts: UpdateOptions,
  ) {
    this.current = { phase: "idle", current: opts.currentVersion, checkedAt: null, version: null, percent: 0, message: null };
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;
    updater.allowDowngrade = false;

    updater.on("checking-for-update", () => this.go("checking"));
    updater.on("update-available", (info) => this.go("downloading", { version: info.version }));
    updater.on("update-not-available", () => this.go("idle", { checkedAt: this.stamp() }));
    updater.on("download-progress", (p) => {
      if (this.current.phase === "downloading") this.go("downloading", { version: this.current.version, percent: Math.round(p.percent) });
    });
    updater.on("update-downloaded", (info) => this.go("ready", { version: info.version, percent: 100 }));
    updater.on("error", (e) => this.go("error", { message: e.message.split("\n")[0]!.slice(0, 200), checkedAt: this.stamp() }));
  }

  state(): UpdateState {
    return this.current;
  }

  /** Empieza a revisar: una vez pasado `firstDelayMs` (que no frene el arranque) y luego cada `CHECK_EVERY_MS`. */
  start(firstDelayMs = 30_000) {
    if (this.timer) return;
    const run = () => void this.check().catch(() => undefined);
    this.timer = setTimeout(() => {
      run();
      this.timer = setInterval(run, CHECK_EVERY_MS);
    }, firstDelayMs);
  }

  stop() {
    if (this.timer) clearTimeout(this.timer), clearInterval(this.timer);
    this.timer = null;
  }

  /** Busca ahora. Si ya hay una descarga lista, o una revisión en curso, no repite. */
  check(): Promise<UpdateState> {
    if (this.current.phase === "ready" || this.current.phase === "downloading") return Promise.resolve(this.current);
    if (this.checking) return this.checking;
    const url = this.opts.feedUrl();
    if (!url) {
      this.go("idle", { checkedAt: this.stamp() });
      return Promise.resolve(this.current);
    }
    this.updater.setFeedURL({ provider: "generic", url });
    this.checking = this.updater
      .checkForUpdates()
      .then(() => this.current)
      .catch((e: unknown) => {
        // `error` ya se emitió normalmente; esto cubre lo que lance antes de emitirlo.
        if (this.current.phase !== "error") this.go("error", { message: e instanceof Error ? e.message.slice(0, 200) : String(e), checkedAt: this.stamp() });
        return this.current;
      })
      .finally(() => (this.checking = null));
    return this.checking;
  }

  /** Cierra la caja e instala lo descargado (la caja se vuelve a abrir sola). Solo si ya está lista. */
  installNow(): boolean {
    if (this.current.phase !== "ready") return false;
    this.updater.quitAndInstall(false, true);
    return true;
  }

  private stamp() {
    return (this.opts.now?.() ?? new Date()).toISOString();
  }

  /** Pasa a otra fase: lo que no se indica vuelve a su valor inicial (salvo la versión instalada y la última revisión). */
  private go(phase: UpdateState["phase"], extra: Partial<Pick<UpdateState, "version" | "percent" | "message" | "checkedAt">> = {}) {
    this.current = {
      phase,
      current: this.opts.currentVersion,
      checkedAt: extra.checkedAt ?? this.current.checkedAt,
      version: extra.version ?? (phase === "checking" ? this.current.version : null),
      percent: extra.percent ?? 0,
      message: extra.message ?? null,
    };
    this.opts.onChange(this.current);
  }
}

/** Dirección de las versiones: la de `POS_UPDATE_URL` (pruebas, otro servidor), o la del servidor al que está conectada la caja. */
export function feedUrlFor(serverUrl: string | null, override: string | undefined): string | null {
  const url = (override?.trim() || (serverUrl ? `${serverUrl.replace(/\/+$/, "")}/updates/caja` : "")).replace(/\/+$/, "");
  return /^https?:\/\//i.test(url) ? url : null;
}
