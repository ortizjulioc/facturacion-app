"use client";

import { useMemo, useState } from "react";
import { TAX_LABELS } from "@facturacion/core";
import { BarChart } from "@/components/bar-chart";
import { ReportTabs } from "@/components/report-tabs";
import {
  Button,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  PageHeader,
  Select,
  tableStyles,
} from "@/components/ui";
import { usePanel } from "@/components/panel-context";
import { API_URL, api, errorMessage, unwrap } from "@/lib/api";
import { money, monthStartLocal, PAYMENT_LABELS, todayLocal } from "@/lib/format";
import { useQuery } from "@/lib/use-query";

export function ReportesView() {
  const { canManage } = usePanel();
  const [from, setFrom] = useState(monthStartLocal);
  const [to, setTo] = useState(todayLocal);
  const [groupBy, setGroupBy] = useState<"day" | "month">("day");
  const [exportError, setExportError] = useState<string | null>(null);

  const valid = Boolean(from) && Boolean(to) && from <= to;
  const load = useMemo(
    () => async () =>
      valid
        ? (
            await unwrap(
              await api.v1.reports.sales.$get({ query: { from, to, groupBy } }),
            )
          ).data
        : null,
    [from, to, groupBy, valid],
  );
  const report = useQuery(load);
  const data = report.data;

  async function exportCsv() {
    setExportError(null);
    try {
      const res = await fetch(`${API_URL}/v1/reports/sales.csv?from=${from}&to=${to}`, {
        credentials: "include",
      });
      if (!res.ok)
        throw new Error(
          ((await res.json().catch(() => null)) as { error?: string } | null)?.error ??
            "No se pudo exportar",
        );
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = `ventas-${from}_${to}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setExportError(errorMessage(e));
    }
  }

  if (!canManage) {
    return (
      <>
        <PageHeader title="Reportes" />
        <ErrorNote message="Solo propietarios y administradores pueden ver los reportes." />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Reportes de ventas"
        description="Comprobantes emitidos. Las notas de crédito restan y los dólares se convierten a pesos con su tasa."
        actions={
          <Button variant="secondary" disabled={!valid} onClick={exportCsv}>
            Exportar CSV
          </Button>
        }
      />

      <ReportTabs active="ventas" />

      <div className="flex flex-wrap items-end gap-3">
        <Field label="Desde" className="w-44">
          <Input
            type="date"
            value={from}
            max={to}
            onChange={(e) => setFrom(e.target.value)}
          />
        </Field>
        <Field label="Hasta" className="w-44">
          <Input
            type="date"
            value={to}
            min={from}
            onChange={(e) => setTo(e.target.value)}
          />
        </Field>
        <Field label="Agrupar por" className="w-40">
          <Select
            value={groupBy}
            onChange={(e) => setGroupBy(e.target.value as "day" | "month")}
          >
            <option value="day">Día</option>
            <option value="month">Mes</option>
          </Select>
        </Field>
      </div>
      {!valid && (
        <ErrorNote message="La fecha inicial no puede ser posterior a la final." />
      )}
      <ErrorNote message={report.error ?? exportError} />

      {data && (
        <>
          <section className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <Kpi label="Ventas netas" value={money(data.totals.net)} strong />
            <Kpi label="ITBIS" value={money(data.totals.tax)} />
            <Kpi label="Subtotal sin ITBIS" value={money(data.totals.subtotal)} />
            <Kpi label="Comprobantes" value={String(data.totals.documents)} />
          </section>

          <section className="space-y-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
            <h2 className="font-medium">
              Ventas por {groupBy === "day" ? "día" : "mes"}
            </h2>
            <BarChart
              data={data.series.map((r) => ({
                label: groupBy === "day" ? r.period.slice(8) : r.period.slice(0, 7),
                value: Number(r.total),
                title: `${r.period} · ${r.count} comprobante(s) · ${money(r.total)}`,
              }))}
            />
          </section>

          <div className="grid gap-6 md:grid-cols-2">
            <Table
              title="Por tipo de comprobante"
              head={["Tipo", "Cant.", "Total"]}
              empty={data.byType.length === 0}
            >
              {data.byType.map((r) => (
                <tr key={r.type}>
                  <td className={tableStyles.td}>
                    {r.label}
                    <span className="ml-2 font-mono text-xs text-zinc-500">{r.type}</span>
                  </td>
                  <td className={`${tableStyles.td} text-right tabular-nums`}>
                    {r.count}
                  </td>
                  <td className={`${tableStyles.td} text-right tabular-nums`}>
                    {r.type === "E34" ? "−" : ""}
                    {money(r.total)}
                  </td>
                </tr>
              ))}
            </Table>

            <Table
              title="Por forma de pago"
              head={["Forma", "Total"]}
              empty={data.payments.length === 0}
            >
              {data.payments.map((p) => (
                <tr key={p.method}>
                  <td className={tableStyles.td}>
                    {PAYMENT_LABELS[p.method] ?? p.method}
                  </td>
                  <td className={`${tableStyles.td} text-right tabular-nums`}>
                    {money(p.amount)}
                  </td>
                </tr>
              ))}
            </Table>

            <Table
              title="ITBIS del período"
              head={["Concepto", "Base", "ITBIS"]}
              empty={false}
            >
              <tr>
                <td className={tableStyles.td}>{TAX_LABELS.ITBIS18}</td>
                <td className={`${tableStyles.td} text-right tabular-nums`}>
                  {money(data.taxes.base18)}
                </td>
                <td className={`${tableStyles.td} text-right tabular-nums`}>
                  {money(data.taxes.tax18)}
                </td>
              </tr>
              <tr>
                <td className={tableStyles.td}>{TAX_LABELS.ITBIS16}</td>
                <td className={`${tableStyles.td} text-right tabular-nums`}>
                  {money(data.taxes.base16)}
                </td>
                <td className={`${tableStyles.td} text-right tabular-nums`}>
                  {money(data.taxes.tax16)}
                </td>
              </tr>
              <tr>
                <td className={tableStyles.td}>{TAX_LABELS.ITBIS0}</td>
                <td className={`${tableStyles.td} text-right tabular-nums`}>
                  {money(data.taxes.base0)}
                </td>
                <td className={`${tableStyles.td} text-right tabular-nums`}>—</td>
              </tr>
              <tr>
                <td className={tableStyles.td}>{TAX_LABELS.EXENTO}</td>
                <td className={`${tableStyles.td} text-right tabular-nums`}>
                  {money(data.taxes.exempt)}
                </td>
                <td className={`${tableStyles.td} text-right tabular-nums`}>—</td>
              </tr>
            </Table>

            <Table
              title="Más vendidos"
              head={["Producto", "Cant.", "Total"]}
              empty={data.topProducts.length === 0}
            >
              {data.topProducts.map((p) => (
                <tr key={p.name}>
                  <td className={tableStyles.td}>{p.name}</td>
                  <td className={`${tableStyles.td} text-right tabular-nums`}>
                    {p.quantity}
                  </td>
                  <td className={`${tableStyles.td} text-right tabular-nums`}>
                    {money(p.total)}
                  </td>
                </tr>
              ))}
            </Table>
          </div>
        </>
      )}
      {!data && !report.error && valid && <EmptyState>Cargando…</EmptyState>}
    </>
  );
}

function Kpi({
  label,
  value,
  strong,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <p
        className={`tabular-nums ${strong ? "text-2xl font-semibold" : "text-xl font-medium"}`}
      >
        {value}
      </p>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{label}</p>
    </div>
  );
}

function Table({
  title,
  head,
  empty,
  children,
}: {
  title: string;
  head: string[];
  empty: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <h2 className="font-medium">{title}</h2>
      <div className={tableStyles.wrapper}>
        <table className={tableStyles.table}>
          <thead>
            <tr>
              {head.map((h, i) => (
                <th key={h} className={`${tableStyles.th} ${i > 0 ? "text-right" : ""}`}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>{children}</tbody>
        </table>
        {empty && <EmptyState>Sin datos en el período.</EmptyState>}
      </div>
    </section>
  );
}
