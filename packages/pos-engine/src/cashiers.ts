import { verifyPin } from "@facturacion/core";
import type { CashierInfo } from "./api";
import { SaleError } from "./sales";
import { all, one, run, transaction, type Db } from "./store";

export type Cashier = { userId: string; name: string; role: string };

/** Reemplaza la lista de cajeros con la que baja de la nube (si alguien perdió su PIN o se fue, deja de aparecer). */
export function applyCashiers(db: Db, list: CashierInfo[]) {
  transaction(db, () => {
    run(db, "DELETE FROM cashier");
    for (const c of list) {
      run(db, "INSERT INTO cashier (user_id, name, role, pin_hash) VALUES (?, ?, ?, ?)", c.userId, c.name, c.role, c.pin);
    }
  });
}

export const cashiers = (db: Db): Cashier[] =>
  all<{ user_id: string; name: string; role: string }>(db, "SELECT user_id, name, role FROM cashier ORDER BY name COLLATE NOCASE").map(
    (r) => ({ userId: r.user_id, name: r.name, role: r.role }),
  );

export const cashierCount = (db: Db) => one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM cashier")?.n ?? 0;

const MAX_FAILS = 5;
const LOCK_MS = 30_000;

/**
 * Verifica el PIN de un cajero contra el resumen guardado en la caja (funciona sin internet). Tras 5 fallos seguidos
 * de la misma persona se bloquea 30 segundos: no impide un ataque con acceso al archivo, pero frena el adivinar
 * a mano frente a la pantalla.
 */
export class PinGate {
  private fails = new Map<string, { count: number; until: number }>();
  constructor(private readonly db: Db) {}

  async verify(userId: string, pin: string, now = Date.now()): Promise<Cashier> {
    const state = this.fails.get(userId);
    if (state && state.until > now) {
      throw new SaleError(`Demasiados intentos: espera ${Math.ceil((state.until - now) / 1000)} s`);
    }
    const row = one<{ user_id: string; name: string; role: string; pin_hash: string }>(
      this.db,
      "SELECT * FROM cashier WHERE user_id = ?",
      userId,
    );
    if (!row) throw new SaleError("Esa persona no tiene PIN en esta caja");
    if (await verifyPin(pin, row.pin_hash)) {
      this.fails.delete(userId);
      return { userId: row.user_id, name: row.name, role: row.role };
    }
    const count = (state && state.until <= now && state.count >= MAX_FAILS ? 0 : (state?.count ?? 0)) + 1;
    this.fails.set(userId, { count, until: count >= MAX_FAILS ? now + LOCK_MS : 0 });
    throw new SaleError(
      count >= MAX_FAILS ? `PIN incorrecto. Espera ${LOCK_MS / 1000} s para volver a intentar` : "PIN incorrecto",
    );
  }
}
