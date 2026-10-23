import type { AutoStartState } from "../shared/api";

/** Lo que se usa de `app` de Electron (así se prueba sin Electron). */
export type LoginItems = {
  getLoginItemSettings(): { openAtLogin: boolean };
  setLoginItemSettings(settings: { openAtLogin: boolean }): void;
};

export type AutoStartOptions = {
  /** Solo la caja instalada se registra para abrir con el sistema (la de desarrollo no ensucia el registro de Windows). */
  supported: boolean;
  /** Recuerda que ya se aplicó el valor por omisión, para respetar después lo que decida el usuario. */
  initialized: { read(): boolean; write(): void };
};

/**
 * Abrir la caja al encender la PC. Se activa **una sola vez**, la primera vez que corre la caja instalada (una caja
 * registradora que no abre sola es un cajero esperando); desde entonces manda lo que se elija en la pantalla, y una
 * actualización o reinstalación no lo vuelve a cambiar. La fuente de verdad es el propio sistema (en Windows, la clave
 * Run del usuario): si alguien lo quita desde «Aplicaciones de inicio», la pantalla lo refleja.
 */
export class AutoStart {
  constructor(
    private readonly items: LoginItems,
    private readonly opts: AutoStartOptions,
  ) {}

  /** Aplica el valor por omisión (activado) si es la primera vez. */
  applyDefault(): AutoStartState {
    if (this.opts.supported && !this.opts.initialized.read()) {
      this.items.setLoginItemSettings({ openAtLogin: true });
      this.opts.initialized.write();
    }
    return this.state();
  }

  state(): AutoStartState {
    return { supported: this.opts.supported, enabled: this.opts.supported && this.items.getLoginItemSettings().openAtLogin };
  }

  set(enabled: boolean): AutoStartState {
    if (this.opts.supported) {
      this.items.setLoginItemSettings({ openAtLogin: enabled });
      this.opts.initialized.write(); // lo elegido manda sobre el valor por omisión
    }
    return this.state();
  }
}
