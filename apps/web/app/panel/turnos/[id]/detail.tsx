"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { ECF_LABELS, type EcfType } from "@facturacion/core";
import { useDialogs } from "@/components/dialogs";
import { Badge, Button, ErrorNote, Modal, PageHeader, tableStyles } from "@/components/ui";
import { api, unwrap } from "@/lib/api";
import { formatDateTime, money, PAYMENT_LABELS } from "@/lib/format";
import { useQuery } from "@/lib/use-query";
import { CloseShiftForm } from "../close-dialog";

/** Informe del turno tal como lo devuelve la API (el Z, ya cerrado, trae además lo contado y la diferencia). */
type Report = {
  documents: number;
  byType: Record<"E31" | "E32" | "E33" | "E34", { count: number; total: string }>;
  sales: { subtotal: string; tax: string; propina: string; total: string };
  credits: string;
  net: string;
  payments: Record<string, string>;
  cashReceived: string;
  openingAmount: string;
  expectedCash: string;
  countedCash?: string;
  difference?: string;
};

const linkButton =
  "inline-flex items-center justify-center rounded-md border border-zinc-300 px-3.5 py-2 text-sm font-medium transition hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900";

export function TurnoDetail({ id }: { id: string }) {
  const router = useRouter();
  const { toast } = useDialogs();
  const shift = useQuery(
    useCallback(async () => (await unwrap(await api.v1.shifts[":id"].$get({ param: { id } }))).data, [id]),
  );
  const company = useQuery(useCallback(async () => (await unwrap(await api.v1.company.$get())).data, []));
  const [closing, setClosing] = useState(false);

  if (shift.error) return <ErrorNote message={shift.error} />;
  const s = shift.data;
  if (!s) return <p className="text-sm text-zinc-500">Cargando…</p>;

  const report = s.report as unknown as Report;
  const open = s.status === "OPEN";
  const title = open ? "Informe X (turno abierto)" : "Informe Z";
  const diff = report.difference !== undefined ? Number(report.difference) : null;

  return (
    <>
      <div className="no-print">
        <PageHeader
          title={title}
          description={`${s.terminal.name} (${s.terminal.code})`}
          actions={
            <>
              <Link href="/panel/turnos" className={linkButton}>
                Turnos
              </Link>
              <Button variant="secondary" onClick={() => window.print()}>
                Imprimir
              </Button>
              {open && <Button onClick={() => setClosing(true)}>Cerrar turno</Button>}
            </>
          }
        />
      </div>

      {/* Se imprime solo esto (el resto lleva .no-print) */}
      <article className="space-y-5 text-sm">
        <header className="hidden text-center print:block">
          <p className="text-base font-semibold">{company.data?.legalName ?? ""}</p>
          {company.data?.rnc && <p>RNC {company.data.rnc}</p>}
          <p className="font-semibold">{title}</p>
        </header>

        <dl className="grid gap-x-8 gap-y-1 sm:grid-cols-2">
          <Line label="Caja" value={`${s.terminal.name} (${s.terminal.code})`} />
          <Line label="Estado" value={open ? "Abierto" : "Cerrado"} />
          <Line label="Abrió" value={`${s.openedBy.name ?? "—"} · ${formatDateTime(s.openedAt)}`} />
          <Line label="Cerró" value={s.closedAt ? `${s.closedBy?.name ?? "—"} · ${formatDateTime(s.closedAt)}` : "—"} />
        </dl>

        <section className="space-y-2">
          <h2 className="font-medium">Ventas</h2>
          <div className={tableStyles.wrapper}>
            <table className={tableStyles.table}>
              <tbody>
                {(Object.keys(report.byType) as (keyof Report["byType"])[])
                  .filter((t) => report.byType[t].count > 0)
                  .map((t) => (
                    <tr key={t}>
                      <td className={tableStyles.td}>
                        {ECF_LABELS[t as EcfType]} <span className="text-zinc-500">× {report.byType[t].count}</span>
                      </td>
                      <td className={`${tableStyles.td} text-right tabular-nums`}>
                        {t === "E34" ? "−" : ""}
                        {money(report.byType[t].total)}
                      </td>
                    </tr>
                  ))}
                {report.documents === 0 && (
                  <tr>
                    <td className={tableStyles.td} colSpan={2}>
                      Sin comprobantes en este turno.
                    </td>
                  </tr>
                )}
                <Total label="Subtotal" value={report.sales.subtotal} />
                <Total label="ITBIS" value={report.sales.tax} />
                {Number(report.sales.propina) > 0 && <Total label="Propina legal" value={report.sales.propina} />}
                <Total label="Ventas netas" value={report.net} strong />
              </tbody>
            </table>
          </div>
        </section>

        <section className="space-y-2">
          <h2 className="font-medium">Cobros por forma de pago</h2>
          <div className={tableStyles.wrapper}>
            <table className={tableStyles.table}>
              <tbody>
                {Object.entries(report.payments).map(([method, amount]) => (
                  <Total key={method} label={PAYMENT_LABELS[method] ?? method} value={amount} />
                ))}
                {Object.keys(report.payments).length === 0 && (
                  <tr>
                    <td className={tableStyles.td}>Sin cobros.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="space-y-2">
          <h2 className="font-medium">Efectivo</h2>
          <div className={tableStyles.wrapper}>
            <table className={tableStyles.table}>
              <tbody>
                <Total label="Fondo de apertura" value={report.openingAmount} />
                <Total label="Cobrado en efectivo" value={report.cashReceived} />
                <Total label="Efectivo esperado" value={report.expectedCash} strong />
                {report.countedCash !== undefined && <Total label="Efectivo contado" value={report.countedCash} />}
                {diff !== null && (
                  <tr>
                    <td className={`${tableStyles.td} font-semibold`}>Diferencia</td>
                    <td className={`${tableStyles.td} text-right font-semibold tabular-nums`}>
                      {diff === 0 ? (
                        <Badge tone="success">Cuadra</Badge>
                      ) : (
                        <span className="text-amber-700 dark:text-amber-400">
                          {diff > 0 ? "Sobran " : "Faltan "}
                          {money(String(Math.abs(diff).toFixed(2)))}
                        </span>
                      )}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {s.notes && <p className="text-zinc-600 dark:text-zinc-400">Observaciones: {s.notes}</p>}
        </section>

        {!open && (
          <div className="hidden grid-cols-2 gap-10 pt-10 text-center print:grid">
            <p className="border-t border-black pt-1">Cajero</p>
            <p className="border-t border-black pt-1">Supervisor</p>
          </div>
        )}
      </article>

      <Modal open={closing} onClose={() => setClosing(false)} title="Cerrar turno">
        {closing && (
          <CloseShiftForm
            shiftId={s.id}
            onClosed={() => {
              setClosing(false);
              toast("Turno cerrado");
              shift.reload();
              router.refresh();
            }}
          />
        )}
      </Modal>
    </>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="w-20 shrink-0 text-zinc-500">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function Total({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <tr>
      <td className={`${tableStyles.td} ${strong ? "font-semibold" : ""}`}>{label}</td>
      <td className={`${tableStyles.td} text-right tabular-nums ${strong ? "font-semibold" : ""}`}>{money(value)}</td>
    </tr>
  );
}
