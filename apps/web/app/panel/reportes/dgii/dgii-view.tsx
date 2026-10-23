"use client";

import { useMemo, useState } from "react";
import { ReportTabs } from "@/components/report-tabs";
import { Badge, Button, EmptyState, ErrorNote, Field, Input, PageHeader, Select, tableStyles } from "@/components/ui";
import { usePanel } from "@/components/panel-context";
import { API_URL, api, errorMessage, unwrap } from "@/lib/api";
import { money, todayLocal } from "@/lib/format";
import { useQuery } from "@/lib/use-query";

const FORMATS = {
  "606": { label: "606 · Compras de bienes y servicios", help: "Compras registradas del mes, por fecha del comprobante." },
  "607": { label: "607 · Ventas de bienes y servicios", help: "Comprobantes emitidos en el mes." },
  "608": { label: "608 · Comprobantes anulados", help: "Rangos de e-NCF anulados ante la DGII en el mes." },
} as const;
type FormatKey = keyof typeof FORMATS;

/** Filas que se muestran de la vista previa (el archivo siempre lleva todas). */
const PREVIEW_ROWS = 200;

export function DgiiView() {
  const { canManage } = usePanel();
  const [format, setFormat] = useState<FormatKey>("606");
  const [month, setMonth] = useState(() => todayLocal().slice(0, 7)); // AAAA-MM
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  const period = month.replace("-", "");
  const valid = /^\d{4}-\d{2}$/.test(month);
  const load = useMemo(
    () => async () => (valid ? (await unwrap(await api.v1.reports.dgii[":format"].$get({ param: { format }, query: { period } }))).data : null),
    [format, period, valid],
  );
  const report = useQuery(load);
  const data = report.data;

  async function download() {
    setDownloadError(null);
    setDownloading(true);
    try {
      const res = await fetch(`${API_URL}/v1/reports/dgii/${format}/file?period=${period}`, { credentials: "include" });
      if (!res.ok) {
        throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? "No se pudo generar el archivo");
      }
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = data?.filename ?? `DGII_F_${format}_${period}.TXT`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setDownloadError(errorMessage(e));
    } finally {
      setDownloading(false);
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
        title="Formatos DGII (606, 607 y 608)"
        description="Archivos de envío de datos de la DGII armados con lo que hay en el sistema. Revisa la vista previa, corrige los errores y, antes de enviarlo por la Oficina Virtual, pásalo por la Herramienta de Pre-validación de la DGII."
        actions={
          <Button disabled={!valid || !data?.ready || downloading} onClick={download}>
            {downloading ? "Generando…" : "Descargar archivo TXT"}
          </Button>
        }
      />
      <ReportTabs active="dgii" />

      <div className="flex flex-wrap items-end gap-3">
        <Field label="Formato" className="w-80">
          <Select value={format} onChange={(e) => setFormat(e.target.value as FormatKey)}>
            {(Object.keys(FORMATS) as FormatKey[]).map((k) => (
              <option key={k} value={k}>
                {FORMATS[k].label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Período (mes)" className="w-44">
          <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
        </Field>
        <p className="pb-2 text-sm text-zinc-600 dark:text-zinc-400">{FORMATS[format].help}</p>
      </div>
      <ErrorNote message={report.error ?? downloadError} />

      {data && (
        <>
          <section className="flex flex-wrap items-center gap-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
            {data.ready ? <Badge tone="success">Listo para enviar</Badge> : <Badge tone="warning">{data.errors.length} error(es) por corregir</Badge>}
            <span className="text-sm">
              <strong>{data.count}</strong> registro(s) · archivo <span className="font-mono text-xs">{data.filename}</span>
            </span>
            {Object.entries(data.totals).map(([label, value]) => (
              <span key={label} className="text-sm text-zinc-600 dark:text-zinc-400">
                {label}: <span className="tabular-nums text-foreground">{/^\d+$/.test(value) ? value : money(value)}</span>
              </span>
            ))}
          </section>

          {data.errors.length > 0 && (
            <section className="space-y-2">
              <h2 className="font-medium">Errores: no se puede enviar hasta corregirlos</h2>
              <div className={tableStyles.wrapper}>
                <table className={tableStyles.table}>
                  <thead>
                    <tr>
                      <th className={tableStyles.th}>Registro</th>
                      <th className={tableStyles.th}>Qué corregir</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.errors.map((e, i) => (
                      <tr key={`${e.ref}-${i}`}>
                        <td className={`${tableStyles.td} font-mono text-xs`}>{e.ref}</td>
                        <td className={tableStyles.td}>{e.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {format === "606" && (
                <p className="text-sm text-zinc-600 dark:text-zinc-400">
                  La fecha de pago y el tipo de retención en ISR de una compra ya registrada se completan en <strong>Compras</strong>, abriendo la compra.
                </p>
              )}
            </section>
          )}

          {data.warnings.length > 0 && (
            <ul className="list-disc space-y-1 rounded-lg border border-amber-200 bg-amber-50 py-3 pl-8 pr-4 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
              {data.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}

          {data.consumerSummary && (
            <section className="space-y-2 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
              <h2 className="font-medium">Resumen General de Facturas de Consumo (se escribe en la Oficina Virtual)</h2>
              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                Al enviar el 607, la Oficina Virtual pide este resumen aparte. Las facturas de consumo menores de RD$250,000 no van en el archivo.
              </p>
              <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
                <Stat label="Facturas de consumo emitidas" value={String(data.consumerSummary.count)} />
                <Stat label="Monto facturado (sin impuestos)" value={money(data.consumerSummary.billed)} />
                <Stat label="Menores de RD$250,000 (solo resumen)" value={`${data.consumerSummary.belowThreshold.count} · ${money(data.consumerSummary.belowThreshold.billed)}`} />
                <Stat label="De RD$250,000 o más (en el archivo)" value={String(data.consumerSummary.listedInFile)} />
              </dl>
            </section>
          )}

          <section className="space-y-2">
            <h2 className="font-medium">Vista previa del archivo</h2>
            {data.rows.length === 0 ? (
              <EmptyState>Sin registros en el período: se envía el formato en cero.</EmptyState>
            ) : (
              <>
                <div className={tableStyles.wrapper}>
                  <table className={tableStyles.table}>
                    <thead>
                      <tr>
                        <th className={tableStyles.th}>#</th>
                        {data.columns.map((c) => (
                          <th key={c} className={`${tableStyles.th} whitespace-nowrap`}>
                            {c}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {data.rows.slice(0, PREVIEW_ROWS).map((row, i) => (
                        <tr key={i}>
                          <td className={`${tableStyles.td} text-zinc-500`}>{i + 1}</td>
                          {row.map((cell, j) => (
                            <td key={j} className={`${tableStyles.td} whitespace-nowrap font-mono text-xs`}>
                              {cell}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {data.rows.length > PREVIEW_ROWS && (
                  <p className="text-sm text-zinc-600 dark:text-zinc-400">
                    Se muestran los primeros {PREVIEW_ROWS} de {data.rows.length} registros; el archivo lleva todos.
                  </p>
                )}
              </>
            )}
          </section>
        </>
      )}
      {!data && !report.error && valid && <EmptyState>Cargando…</EmptyState>}
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-zinc-600 dark:text-zinc-400">{label}</dt>
      <dd className="mt-0.5 text-base font-medium tabular-nums">{value}</dd>
    </div>
  );
}
