"use client";

import { useCallback, useState, type FormEvent } from "react";
import { Badge, Button, ErrorNote, Field, Input, Modal, tableStyles } from "@/components/ui";
import { useDialogs } from "@/components/dialogs";
import { api, errorMessage, unwrap } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { useQuery } from "@/lib/use-query";

const fmt = (type: string, n: number) => `E${type.slice(1)}${String(n).padStart(10, "0")}`;

type SeqLike = { id: string; ecfType: string; nextNumber: number; toNumber: number; remaining: number };

/** Anular ante la DGII los números sin usar de una secuencia (el inicio o el final de lo que queda). */
export function AnnulDialog({ sequence, onClose, onDone }: { sequence: SeqLike | null; onClose: () => void; onDone: () => void }) {
  const { toast } = useDialogs();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!sequence) return;
    setError(null);
    const f = new FormData(e.currentTarget);
    setBusy(true);
    try {
      const row = (
        await unwrap(
          await api.v1.sequences.annulments.$post({
            json: { sequenceId: sequence.id, from: Number(f.get("from")), to: Number(f.get("to")) },
          }),
        )
      ).data;
      if (row.state === "DONE") {
        toast(`Se anularon ${row.count.toLocaleString("en-US")} e-NCF`);
        onDone();
      } else {
        setError(row.error ?? "La DGII no anuló los números");
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={!!sequence} onClose={onClose} title="Anular números sin usar">
      {sequence && (
        <form onSubmit={onSubmit} className="space-y-4">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Se informa a la DGII que estos e-NCF no se usarán y no se podrán usar después. Solo se puede anular el inicio o el final de lo que queda sin usar:{" "}
            <span className="font-mono text-xs">
              {fmt(sequence.ecfType, sequence.nextNumber)} – {fmt(sequence.ecfType, sequence.toNumber)}
            </span>
            .
          </p>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Desde">
              <Input name="from" type="number" required min={sequence.nextNumber} max={sequence.toNumber} defaultValue={sequence.nextNumber} />
            </Field>
            <Field label="Hasta">
              <Input name="to" type="number" required min={sequence.nextNumber} max={sequence.toNumber} defaultValue={sequence.toNumber} />
            </Field>
          </div>
          <ErrorNote message={error} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
              Cancelar
            </Button>
            <Button variant="danger" disabled={busy}>
              {busy ? "Anulando…" : "Anular en la DGII"}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

/** Constancia de las anulaciones hechas. */
export function AnnulmentHistory({ refreshKey }: { refreshKey: number }) {
  const { toast } = useDialogs();
  const load = useCallback(async () => (await unwrap(await api.v1.sequences.annulments.$get())).data, [refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const { data, error, reload } = useQuery(load);
  if (!data || data.length === 0) return error ? <ErrorNote message={error} /> : null;

  async function cancel(id: string) {
    try {
      await unwrap(await api.v1.sequences.annulments[":id"].cancel.$post({ param: { id } }));
      toast("Anulación cancelada");
      reload();
    } catch (e) {
      toast(errorMessage(e));
    }
  }

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-medium">Anulaciones de e-NCF</h2>
      <div className={tableStyles.wrapper}>
        <table className={tableStyles.table}>
          <thead>
            <tr>
              <th className={tableStyles.th}>Fecha</th>
              <th className={tableStyles.th}>Rango</th>
              <th className={`${tableStyles.th} text-right`}>Cantidad</th>
              <th className={tableStyles.th}>Resultado</th>
            </tr>
          </thead>
          <tbody>
            {data.map((a) => (
              <tr key={a.id}>
                <td className={`${tableStyles.td} whitespace-nowrap`}>{formatDateTime(a.createdAt)}</td>
                <td className={`${tableStyles.td} font-mono text-xs`}>
                  {fmt(a.ecfType, a.fromNumber)} – {fmt(a.ecfType, a.toNumber)}
                </td>
                <td className={`${tableStyles.td} text-right tabular-nums`}>{a.count.toLocaleString("en-US")}</td>
                <td className={tableStyles.td}>
                  <Badge tone={a.state === "DONE" ? "success" : a.state === "FAILED" ? "warning" : "neutral"}>
                    {a.state === "DONE" ? "Anulados" : a.state === "FAILED" ? "No se anularon" : "En curso"}
                  </Badge>
                  {a.error && <div className="text-xs text-zinc-500">{a.error}</div>}
                  {a.state === "PENDING" && (
                    <Button variant="ghost" onClick={() => void cancel(a.id)}>
                      Cancelar
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
