import { useState } from "react";
import type { PosState } from "../../shared/api";
import { errorOf, Field, SignInForm } from "./ui";

type Org = { id: string; name: string };
type Terminal = { id: string; name: string; code: string };

/** Configuración inicial: conectar con el servidor, elegir la empresa y la caja que será esta instalación. */
export function Setup({ state, onDone }: { state: PosState; onDone: () => void }) {
  const [step, setStep] = useState<"login" | "org" | "terminal" | "syncing">("login");
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [org, setOrg] = useState<Org | null>(null);
  const [terminals, setTerminals] = useState<Terminal[]>([]);
  const [terminalId, setTerminalId] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function pickOrg(o: Org) {
    setError(null);
    try {
      const list = await window.pos.terminals(o.id);
      setOrg(o);
      setTerminals(list);
      setTerminalId(list[0]?.id ?? "");
      setStep("terminal");
    } catch (e) {
      setError(errorOf(e));
    }
  }

  async function finish() {
    if (!org || !terminalId) return;
    setError(null);
    setStep("syncing");
    try {
      const report = await window.pos.selectTerminal({ organization: org, terminalId });
      if (report.error) setError(report.error);
      onDone();
    } catch (e) {
      setError(errorOf(e));
      setStep("terminal");
    }
  }

  return (
    <div className="center" data-screen="setup">
      <div className="card setup">
        <h1>Configurar la caja</h1>
        <p className="muted">Conecta esta computadora con tu cuenta para descargar el catálogo y los números de comprobante.</p>

        {step === "login" && (
          <SignInForm
            serverUrl={state.serverUrl ?? ""}
            email={state.user?.email ?? ""}
            submitLabel="Conectar"
            onSignedIn={(list) => {
              setOrgs(list);
              if (list.length === 1) void pickOrg(list[0]!);
              else setStep("org");
            }}
          />
        )}

        {step === "org" && (
          <div className="stack">
            <h2>¿Qué empresa?</h2>
            {orgs.length === 0 && <p className="error">Tu usuario no pertenece a ninguna empresa.</p>}
            {orgs.map((o) => (
              <button key={o.id} className="choice" onClick={() => void pickOrg(o)}>{o.name}</button>
            ))}
          </div>
        )}

        {step === "terminal" && (
          <div className="stack">
            <h2>{org?.name}</h2>
            {terminals.length === 0 ? (
              <p className="error">Esta empresa no tiene cajas activas. Créalas en el panel web (Sucursales y cajas).</p>
            ) : (
              <Field label="¿Qué caja es esta?">
                <select value={terminalId} onChange={(e) => setTerminalId(e.target.value)}>
                  {terminals.map((t) => (
                    <option key={t.id} value={t.id}>{t.name} ({t.code})</option>
                  ))}
                </select>
              </Field>
            )}
            <button className="primary" disabled={!terminalId} onClick={() => void finish()}>Configurar esta caja</button>
            <button className="link" onClick={() => setStep("login")}>Usar otra cuenta</button>
          </div>
        )}

        {step === "syncing" && <p className="muted" role="status">Descargando el catálogo y reservando números de comprobante…</p>}
        {error && <p className="error" role="alert">{error}</p>}
      </div>
    </div>
  );
}
