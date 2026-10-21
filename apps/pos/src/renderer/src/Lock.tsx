import { useCallback, useEffect, useState } from "react";
import type { Cashier, PosState } from "../../shared/api";
import { errorOf } from "./ui";

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "⌫", "0", "OK"] as const;

/** Pantalla de bloqueo: se elige quién es y se escribe el PIN (con el teclado de la pantalla o el físico). */
export function Lock({ state, onUnlocked }: { state: PosState; onUnlocked: () => void }) {
  const [cashiers, setCashiers] = useState<Cashier[]>([]);
  const [who, setWho] = useState<string>("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    window.pos.cashiers().then((list) => {
      setCashiers(list);
      // Si solo hay una persona, ya viene elegida; si alguien ya entró antes en esta caja, se sugiere.
      setWho((current) => current || (list.length === 1 ? list[0]!.userId : (localStorage.getItem("lastCashier") ?? "")));
    }, () => undefined);
  }, []);

  const submit = useCallback(
    async (value: string) => {
      if (!who || busy) return;
      setBusy(true);
      setError(null);
      try {
        await window.pos.unlock(who, value);
        localStorage.setItem("lastCashier", who);
        onUnlocked();
      } catch (e) {
        setError(errorOf(e));
        setPin("");
        setBusy(false);
      }
    },
    [who, busy, onUnlocked],
  );

  const press = useCallback(
    (key: string) => {
      setError(null);
      if (key === "⌫") setPin((p) => p.slice(0, -1));
      else if (key === "OK") void submit(pin);
      else setPin((p) => (p.length < 6 ? p + key : p));
    },
    [pin, submit],
  );

  // Teclado físico: dígitos, Backspace y Enter.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === "Backspace") press("⌫");
      else if (e.key === "Enter") press("OK");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [press]);

  return (
    <div className="center" data-screen="lock">
      <div className="card lock">
        <h1>{state.company?.tradeName ?? state.company?.legalName ?? state.organization?.name}</h1>
        <p className="muted">{state.terminal?.name} · Identifícate para vender</p>

        <div className="who" role="group" aria-label="¿Quién eres?">
          {cashiers.map((c) => (
            <button key={c.userId} className={who === c.userId ? "on" : ""} onClick={() => { setWho(c.userId); setPin(""); setError(null); }}>
              {c.name}
            </button>
          ))}
        </div>

        <div className="pin-dots" aria-label={`PIN: ${pin.length} dígitos`} role="status">
          {Array.from({ length: Math.max(4, pin.length) }, (_, i) => (
            <span key={i} className={i < pin.length ? "filled" : ""} />
          ))}
        </div>
        {error && <p className="error" role="alert">{error}</p>}

        <div className="keypad">
          {KEYS.map((k) => (
            <button key={k} className={k === "OK" ? "primary" : ""} disabled={busy || !who || (k === "OK" && pin.length < 4)} onClick={() => press(k)}>
              {k}
            </button>
          ))}
        </div>
        {!who && <p className="muted small">Elige tu nombre para escribir el PIN.</p>}
      </div>
    </div>
  );
}
