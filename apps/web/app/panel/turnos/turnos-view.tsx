"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useState, type FormEvent } from "react";
import { useDialogs } from "@/components/dialogs";
import {
  Badge,
  Button,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  Modal,
  PageHeader,
  Pagination,
  Select,
  tableStyles,
} from "@/components/ui";
import { api, errorMessage, unwrap } from "@/lib/api";
import { formatDateTime, money, PAYMENT_LABELS } from "@/lib/format";
import { useQuery } from "@/lib/use-query";
import { CloseShiftForm } from "./close-dialog";

const PAGE_SIZE = 15;

export function TurnosView() {
  const router = useRouter();
  const { toast } = useDialogs();
  const terminals = useQuery(
    useCallback(
      async () => (await unwrap(await api.v1.terminals.$get({ query: {} }))).data.filter((t) => t.active),
      [],
    ),
  );
  const [pick, setPick] = useState("");
  const terminalId = pick || terminals.data?.[0]?.id || "";

  const current = useQuery(
    useCallback(async () => {
      if (!terminalId) return null;
      return (await unwrap(await api.v1.shifts.current.$get({ query: { terminalId } }))).data;
    }, [terminalId]),
  );

  const [status, setStatus] = useState<"" | "OPEN" | "CLOSED">("");
  const [page, setPage] = useState(1);
  const history = useQuery(
    useCallback(
      async () =>
        unwrap(
          await api.v1.shifts.$get({
            query: { page: String(page), pageSize: String(PAGE_SIZE), ...(status ? { status } : {}) },
          }),
        ),
      [page, status],
    ),
  );

  const [opening, setOpening] = useState(false);
  const [closing, setClosing] = useState(false);

  const shift = current.data;
  const reloadAll = () => {
    current.reload();
    history.reload();
  };

  return (
    <>
      <PageHeader
        title="Turnos de caja"
        description="Abre el turno con el fondo de la gaveta, vende y ciérralo contando el efectivo. Cada comprobante emitido en la caja queda en su turno."
      />

      <section className="space-y-4 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <Field label="Caja" className="w-56">
            <Select value={terminalId} onChange={(e) => setPick(e.target.value)} disabled={!terminals.data?.length}>
              {terminals.data?.length === 0 && <option value="">Sin cajas</option>}
              {terminals.data?.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.code})
                </option>
              ))}
            </Select>
          </Field>
          {terminalId && !shift && !current.error && current.data !== undefined && (
            <Button onClick={() => setOpening(true)}>Abrir turno</Button>
          )}
          {shift && (
            <div className="flex gap-2">
              <Link
                href={`/panel/turnos/${shift.id}`}
                className="inline-flex items-center justify-center rounded-md border border-zinc-300 px-3.5 py-2 text-sm font-medium transition hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
              >
                Informe X
              </Link>
              <Button onClick={() => setClosing(true)}>Cerrar turno</Button>
            </div>
          )}
        </div>

        <ErrorNote message={current.error ?? terminals.error} />
        {terminals.data?.length === 0 && (
          <EmptyState>Aún no hay cajas. Créalas en «Sucursales y cajas».</EmptyState>
        )}
        {terminalId && current.data === null && (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">Esta caja no tiene un turno abierto.</p>
        )}
        {shift && (
          <div className="space-y-2 text-sm">
            <p>
              <Badge tone="success">Abierto</Badge>{" "}
              <span className="text-zinc-600 dark:text-zinc-400">
                por {shift.openedBy.name ?? "—"} · {formatDateTime(shift.openedAt)} · fondo {money(shift.openingAmount)}
              </span>
            </p>
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Kpi label="Comprobantes" value={String(shift.report.documents)} />
              <Kpi label="Ventas netas" value={money(shift.report.net)} />
              {Object.entries(shift.report.payments).map(([method, amount]) => (
                <Kpi key={method} label={PAYMENT_LABELS[method] ?? method} value={money(amount)} />
              ))}
            </dl>
          </div>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-medium">Historial</h2>
          <Select
            aria-label="Estado"
            className="w-40"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as "" | "OPEN" | "CLOSED");
              setPage(1);
            }}
          >
            <option value="">Todos</option>
            <option value="OPEN">Abiertos</option>
            <option value="CLOSED">Cerrados</option>
          </Select>
        </div>
        <ErrorNote message={history.error} />
        <div className={tableStyles.wrapper}>
          <table className={tableStyles.table}>
            <thead>
              <tr>
                <th className={tableStyles.th}>Caja</th>
                <th className={tableStyles.th}>Cajero</th>
                <th className={tableStyles.th}>Apertura</th>
                <th className={tableStyles.th}>Cierre</th>
                <th className={`${tableStyles.th} text-right`}>Diferencia</th>
                <th className={tableStyles.th} />
              </tr>
            </thead>
            <tbody>
              {history.data?.data.map((s) => (
                <tr key={s.id}>
                  <td className={tableStyles.td}>{s.terminal.name}</td>
                  <td className={tableStyles.td}>{s.openedBy.name ?? "—"}</td>
                  <td className={tableStyles.td}>{formatDateTime(s.openedAt)}</td>
                  <td className={tableStyles.td}>
                    {s.status === "OPEN" ? <Badge tone="success">Abierto</Badge> : formatDateTime(s.closedAt)}
                  </td>
                  <td
                    className={`${tableStyles.td} text-right tabular-nums ${
                      s.difference && Number(s.difference) !== 0 ? "text-amber-700 dark:text-amber-400" : ""
                    }`}
                  >
                    {s.difference === null ? "—" : money(s.difference)}
                  </td>
                  <td className={`${tableStyles.td} text-right`}>
                    <Link href={`/panel/turnos/${s.id}`} className="underline">
                      {s.status === "OPEN" ? "Informe X" : "Informe Z"}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {history.data && history.data.data.length === 0 && <EmptyState>Aún no hay turnos.</EmptyState>}
          {!history.data && !history.error && <EmptyState>Cargando…</EmptyState>}
        </div>
        {history.data && (
          <Pagination page={history.data.page} pageSize={history.data.pageSize} total={history.data.total} onPage={setPage} />
        )}
      </section>

      <Modal open={opening} onClose={() => setOpening(false)} title="Abrir turno">
        {opening && (
          <OpenShiftForm
            terminalId={terminalId}
            onOpened={() => {
              setOpening(false);
              toast("Turno abierto");
              reloadAll();
            }}
          />
        )}
      </Modal>

      <Modal open={closing} onClose={() => setClosing(false)} title="Cerrar turno">
        {closing && shift && (
          <CloseShiftForm
            shiftId={shift.id}
            onClosed={() => {
              setClosing(false);
              toast("Turno cerrado");
              router.push(`/panel/turnos/${shift.id}`);
            }}
          />
        )}
      </Modal>
    </>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
      <dt className="text-xs text-zinc-500">{label}</dt>
      <dd className="text-base font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

function OpenShiftForm({ terminalId, onOpened }: { terminalId: string; onOpened: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    const amount = String(new FormData(e.currentTarget).get("openingAmount") ?? "").trim().replace(",", ".");
    try {
      await unwrap(
        await api.v1.shifts.$post({ json: { terminalId, openingAmount: amount || "0" } }),
      );
      onOpened();
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label="Fondo de caja (RD$)" hint="El efectivo con el que empieza la gaveta.">
        <Input name="openingAmount" inputMode="decimal" placeholder="0.00" defaultValue="0.00" autoFocus />
      </Field>
      <ErrorNote message={error} />
      <div className="flex justify-end">
        <Button disabled={saving}>{saving ? "Abriendo…" : "Abrir turno"}</Button>
      </div>
    </form>
  );
}
