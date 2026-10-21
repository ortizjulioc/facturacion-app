"use client";

import { useState, type FormEvent } from "react";
import { Button, ErrorNote, Field, Input } from "@/components/ui";
import { api, errorMessage, unwrap } from "@/lib/api";

/**
 * Cierre del turno. El efectivo esperado NO se muestra: se cuenta la gaveta primero y el cuadre sale en el informe Z
 * (así el conteo es honesto). Si hay diferencia, la API pide el motivo y el campo de notas queda a la vista.
 */
export function CloseShiftForm({
  shiftId,
  onClosed,
}: {
  shiftId: string;
  onClosed: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [needsReason, setNeedsReason] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    const f = new FormData(e.currentTarget);
    try {
      await unwrap(
        await api.v1.shifts[":id"].close.$post({
          param: { id: shiftId },
          json: {
            countedCash: String(f.get("countedCash") ?? "").trim().replace(",", "."),
            notes: String(f.get("notes") ?? "").trim(),
          },
        }),
      );
      onClosed();
    } catch (err) {
      const message = errorMessage(err);
      setNeedsReason(/diferencia/i.test(message));
      setError(message);
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label="Efectivo contado en la gaveta (RD$)" hint="Cuenta el dinero que hay ahora, incluido el fondo inicial.">
        <Input name="countedCash" required inputMode="decimal" placeholder="0.00" autoFocus />
      </Field>
      <Field
        label={needsReason ? "Motivo de la diferencia" : "Notas del cierre (opcional)"}
        hint={needsReason ? "El efectivo contado no coincide con el esperado." : undefined}
      >
        <Input name="notes" maxLength={500} required={needsReason} />
      </Field>
      <ErrorNote message={error} />
      <div className="flex justify-end">
        <Button disabled={saving}>{saving ? "Cerrando…" : "Cerrar turno"}</Button>
      </div>
    </form>
  );
}
