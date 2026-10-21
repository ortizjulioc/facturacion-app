import { useCallback, useEffect, useState } from "react";
import type { PosState } from "../../shared/api";
import { Register } from "./Register";
import { Setup } from "./Setup";

/** Raíz: decide entre configurar la caja y vender. Mantiene al día el estado (sincronización, números, pendientes). */
export function App() {
  const [state, setState] = useState<PosState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setState(await window.pos.state());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void reload();
    // La sincronización automática del proceso principal avisa aquí al terminar.
    return window.pos.onSynced(() => void reload());
  }, [reload]);

  if (error) return <div className="center" data-screen="error"><p className="error">{error}</p></div>;
  if (!state) return <div className="center" data-screen="loading">Cargando…</div>;
  if (state.stage === "setup") return <Setup state={state} onDone={reload} />;
  return <Register state={state} reload={reload} />;
}
