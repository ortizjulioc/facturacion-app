"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { Button, Input, Modal } from "./ui";

type ConfirmOptions = {
  title: string;
  message?: string;
  confirmLabel?: string;
  /** Acción destructiva: el botón se muestra en rojo. */
  danger?: boolean;
};

type PromptOptions = {
  title: string;
  label: string;
  initialValue?: string;
  confirmLabel?: string;
};

type ToastTone = "success" | "error";
type Toast = { id: number; message: string; tone: ToastTone };

type Dialogs = {
  /** Reemplaza a `window.confirm`: devuelve true si el usuario confirma. */
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  /** Reemplaza a `window.prompt`: devuelve el texto o null si cancela. */
  prompt: (options: PromptOptions) => Promise<string | null>;
  /** Aviso breve en la esquina inferior. */
  toast: (message: string, tone?: ToastTone) => void;
};

const DialogContext = createContext<Dialogs | null>(null);

export function useDialogs(): Dialogs {
  const value = useContext(DialogContext);
  if (!value) throw new Error("useDialogs debe usarse dentro de <DialogProvider>");
  return value;
}

type Active =
  | { kind: "confirm"; options: ConfirmOptions; resolve: (ok: boolean) => void }
  | { kind: "prompt"; options: PromptOptions; resolve: (value: string | null) => void };

export function DialogProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<Active | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);

  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => setActive({ kind: "confirm", options, resolve })),
    [],
  );
  const prompt = useCallback(
    (options: PromptOptions) =>
      new Promise<string | null>((resolve) =>
        setActive({ kind: "prompt", options, resolve }),
      ),
    [],
  );
  const toast = useCallback((message: string, tone: ToastTone = "success") => {
    const id = ++nextId.current;
    setToasts((list) => [...list, { id, message, tone }]);
    setTimeout(
      () => setToasts((list) => list.filter((t) => t.id !== id)),
      tone === "error" ? 6000 : 3000,
    );
  }, []);

  /** Resuelve la promesa una sola vez (cerrar con Escape y con botones dispara el cierre dos veces). */
  const settle = useCallback((result: boolean | string | null) => {
    setActive((current) => {
      if (!current) return null;
      if (current.kind === "confirm") current.resolve(result === true);
      else current.resolve(typeof result === "string" ? result : null);
      return null;
    });
  }, []);

  const value = useMemo(() => ({ confirm, prompt, toast }), [confirm, prompt, toast]);

  return (
    <DialogContext.Provider value={value}>
      {children}

      <Modal
        open={active !== null}
        onClose={() => settle(active?.kind === "confirm" ? false : null)}
        title={active?.options.title ?? ""}
      >
        {active?.kind === "confirm" && (
          <div className="space-y-5">
            {active.options.message && (
              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                {active.options.message}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => settle(false)}>
                Cancelar
              </Button>
              <Button
                variant={active.options.danger ? "danger" : "primary"}
                autoFocus
                onClick={() => settle(true)}
              >
                {active.options.confirmLabel ?? "Aceptar"}
              </Button>
            </div>
          </div>
        )}
        {active?.kind === "prompt" && (
          <PromptBody options={active.options} onSubmit={settle} />
        )}
      </Modal>

      <div
        aria-live="polite"
        role="status"
        className="no-print pointer-events-none fixed right-4 bottom-4 z-50 flex max-w-sm flex-col gap-2"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`pointer-events-auto rounded-md px-4 py-3 text-sm shadow-lg ${
              t.tone === "error"
                ? "bg-red-600 text-white"
                : "bg-foreground text-background"
            }`}
          >
            {t.message}
          </div>
        ))}
      </div>
    </DialogContext.Provider>
  );
}

function PromptBody({
  options,
  onSubmit,
}: {
  options: PromptOptions;
  onSubmit: (value: string | null) => void;
}) {
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const value = String(new FormData(e.currentTarget).get("value") ?? "").trim();
    onSubmit(value || null);
  }
  return (
    <form onSubmit={submit} className="space-y-4">
      <label className="flex flex-col gap-1.5 text-sm font-medium">
        {options.label}
        <Input name="value" autoFocus defaultValue={options.initialValue} />
      </label>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={() => onSubmit(null)}>
          Cancelar
        </Button>
        <Button>{options.confirmLabel ?? "Aceptar"}</Button>
      </div>
    </form>
  );
}
