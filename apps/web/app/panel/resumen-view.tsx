"use client";

import Link from "next/link";
import { useCallback } from "react";
import { BarChart } from "@/components/bar-chart";
import { ErrorNote, PageHeader } from "@/components/ui";
import { usePanel } from "@/components/panel-context";
import { api, unwrap } from "@/lib/api";
import { money, monthStartLocal, todayLocal } from "@/lib/format";
import { useQuery } from "@/lib/use-query";

export function ResumenView() {
  const { organizationName, canManage } = usePanel();

  const load = useCallback(async () => {
    const today = todayLocal();
    const [products, customers, branches, terminals, drafts, lowStock, sales, fiscal] =
      await Promise.all([
        unwrap(await api.v1.products.$get({ query: { pageSize: "1", active: "true" } })),
        unwrap(await api.v1.customers.$get({ query: { pageSize: "1", active: "true" } })),
        unwrap(await api.v1.branches.$get()),
        unwrap(await api.v1.terminals.$get({ query: {} })),
        unwrap(
          await api.v1.documents.$get({ query: { status: "DRAFT", pageSize: "1" } }),
        ),
        unwrap(
          await api.v1.inventory.stock.$get({ query: { low: "true", pageSize: "1" } }),
        ),
        // Los reportes son solo para propietarios y administradores.
        canManage
          ? unwrap(
              await api.v1.reports.sales.$get({
                query: { from: monthStartLocal(), to: today, groupBy: "day" },
              }),
            )
          : null,
        // Lo que necesita atención en los envíos a la DGII (también solo para administradores).
        canManage ? unwrap(await api.v1.fiscal.queue.$get()) : null,
      ]);
    const todayRow = sales?.data.series.find((r) => r.period === today);
    return {
      products: products.total,
      customers: customers.total,
      branches: branches.data.length,
      terminals: terminals.data.length,
      drafts: drafts.total,
      lowStock: lowStock.total,
      sales: sales?.data ?? null,
      fiscal: fiscal?.data ?? null,
      todayTotal: todayRow?.total ?? "0.00",
      todayCount: todayRow?.count ?? 0,
    };
  }, [canManage]);
  const { data, error } = useQuery(load);

  const cards = [
    { label: "Productos activos", value: data?.products, href: "/panel/productos" },
    { label: "Clientes", value: data?.customers, href: "/panel/clientes" },
    { label: "Sucursales", value: data?.branches, href: "/panel/sucursales" },
    { label: "Cajas", value: data?.terminals, href: "/panel/sucursales" },
  ];

  return (
    <>
      <PageHeader
        title={organizationName || "Resumen"}
        description="Estado general de tu empresa."
      />
      <ErrorNote message={error} />

      {data?.sales && (
        <section className="space-y-4">
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <Link
              href="/panel/reportes"
              className="rounded-lg border border-zinc-200 p-4 transition hover:border-zinc-400 dark:border-zinc-800 dark:hover:border-zinc-600"
            >
              <p className="text-2xl font-semibold tabular-nums">
                {money(data.todayTotal)}
              </p>
              <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
                Ventas de hoy · {data.todayCount} comprobante(s)
              </p>
            </Link>
            <Link
              href="/panel/reportes"
              className="rounded-lg border border-zinc-200 p-4 transition hover:border-zinc-400 dark:border-zinc-800 dark:hover:border-zinc-600"
            >
              <p className="text-2xl font-semibold tabular-nums">
                {money(data.sales.totals.net)}
              </p>
              <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
                Ventas del mes
              </p>
            </Link>
            <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
              <p className="text-2xl font-semibold tabular-nums">
                {money(data.sales.totals.tax)}
              </p>
              <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
                ITBIS del mes
              </p>
            </div>
            <Link
              href="/panel/facturas?estado=borrador"
              className="rounded-lg border border-zinc-200 p-4 transition hover:border-zinc-400 dark:border-zinc-800 dark:hover:border-zinc-600"
            >
              <p className="text-2xl font-semibold tabular-nums">{data.drafts}</p>
              <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
                Borradores sin emitir
              </p>
            </Link>
          </div>
          <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
            <h2 className="mb-3 text-sm font-medium">Ventas del mes por día</h2>
            <BarChart
              height={110}
              data={data.sales.series.map((r) => ({
                label: r.period.slice(8),
                value: Number(r.total),
                title: `${r.period} · ${money(r.total)}`,
              }))}
            />
          </div>
        </section>
      )}

      <section className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {cards.map((c) => (
          <Link
            key={c.label}
            href={c.href}
            className="rounded-lg border border-zinc-200 p-4 transition hover:border-zinc-400 dark:border-zinc-800 dark:hover:border-zinc-600"
          >
            <p className="text-3xl font-semibold tabular-nums">{c.value ?? "–"}</p>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{c.label}</p>
          </Link>
        ))}
      </section>

      {data && data.lowStock > 0 && (
        <Link
          href="/panel/inventario?stock=bajo"
          className="block rounded-md bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200"
        >
          {data.lowStock}{" "}
          {data.lowStock === 1
            ? "producto con stock bajo o agotado"
            : "productos con stock bajo o agotado"}
          . <span className="font-medium underline">Ver inventario</span>
        </Link>
      )}

      {data?.fiscal && <FiscalAlerts queue={data.fiscal} />}

      {data && data.branches === 0 && (
        <p className="rounded-md bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          Empieza creando tu primera sucursal y caja en{" "}
          <Link href="/panel/sucursales" className="font-medium underline">
            Sucursales y cajas
          </Link>
          .
        </p>
      )}
    </>
  );
}

type FiscalQueue = {
  failed: { documentId: string; encf: string | null; error: string | null }[];
  rejected: { documentId: string; encf: string | null; messages: string[] }[];
  overdue: { documentId: string; encf: string | null; error: string | null }[];
};

/** Envíos a la DGII que necesitan atención: rechazados (sustituirlos), fallidos (revisar y reintentar) y atrasados. */
function FiscalAlerts({ queue }: { queue: FiscalQueue }) {
  const groups = [
    {
      title: "Rechazados por la DGII: sustitúyelos por otro comprobante",
      tone: "red",
      rows: queue.rejected.map((r) => ({ id: r.documentId, encf: r.encf, why: r.messages.join(" · ") })),
    },
    {
      title: "No se pudieron enviar: revisa el motivo y reintenta",
      tone: "red",
      rows: queue.failed.map((r) => ({ id: r.documentId, encf: r.encf, why: r.error ?? "" })),
    },
    {
      title: "Atrasados: la DGII exige enviarlos en 72 horas",
      tone: "amber",
      rows: queue.overdue.map((r) => ({ id: r.documentId, encf: r.encf, why: r.error ?? "Esperando a la DGII" })),
    },
  ].filter((g) => g.rows.length > 0);
  if (groups.length === 0) return null;
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-medium">Envíos a la DGII</h2>
      {groups.map((g) => (
        <div
          key={g.title}
          className={
            g.tone === "red"
              ? "rounded-md bg-red-50 px-4 py-3 text-sm text-red-900 dark:bg-red-950 dark:text-red-200"
              : "rounded-md bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200"
          }
        >
          <p className="font-medium">
            {g.title} ({g.rows.length})
          </p>
          <ul className="mt-2 space-y-1">
            {g.rows.slice(0, 5).map((r) => (
              <li key={r.id}>
                <Link href={`/panel/facturas/${r.id}`} className="font-medium tabular-nums underline">
                  {r.encf ?? "Sin e-NCF"}
                </Link>
                {r.why && <span className="ml-2">{r.why}</span>}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
