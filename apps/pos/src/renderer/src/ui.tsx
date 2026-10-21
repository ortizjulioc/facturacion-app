import { useEffect, useState, type FormEvent, type ReactNode } from "react";

export const errorOf = (e: unknown) => (e instanceof Error ? e.message : "Ocurrió un error inesperado");

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="overlay" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? " wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <header>
          <h2>{title}</h2>
          <button className="icon" aria-label="Cerrar" onClick={onClose}>✕</button>
        </header>
        <div className="body">{children}</div>
      </div>
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

/** Formulario de inicio de sesión (se usa al configurar la caja y al reconectarla). */
export function SignInForm(props: {
  serverUrl: string;
  email: string;
  lockServer?: boolean;
  submitLabel: string;
  onSignedIn: (organizations: { id: string; name: string }[]) => void | Promise<void>;
}) {
  const [serverUrl, setServerUrl] = useState(props.serverUrl || "http://localhost:3001");
  const [email, setEmail] = useState(props.email);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const { organizations } = await window.pos.signIn({ serverUrl, email, password });
      await props.onSignedIn(organizations);
    } catch (err) {
      setError(errorOf(err));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="stack">
      <Field label="Dirección del servidor">
        <input value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} disabled={props.lockServer} required placeholder="https://api.tuempresa.com" />
      </Field>
      <Field label="Correo">
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus={!props.email} />
      </Field>
      <Field label="Contraseña">
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus={!!props.email} />
      </Field>
      {error && <p className="error" role="alert">{error}</p>}
      <button className="primary" disabled={busy}>{busy ? "Conectando…" : props.submitLabel}</button>
    </form>
  );
}
