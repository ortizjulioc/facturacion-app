"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import {
  Badge,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  PageHeader,
  Pagination,
  Select,
  tableStyles,
} from "@/components/ui";
import { usePanel } from "@/components/panel-context";
import { api, unwrap } from "@/lib/api";
import { formatDate, money } from "@/lib/format";
import { useDebounced, useQuery } from "@/lib/use-query";

const PAGE_SIZE = 20;
const KINDS = [
  { value: "SUPPLIER_INVOICE", label: "Factura de proveedor" },
  { value: "E41", label: "Comprobante de compras (E41)" },
  { value: "E43", label: "Gasto menor (E43)" },
] as const;

export function ComprasView() {
  const router = useRouter();
  const { canManage } = usePanel();
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim());
  const [page, setPage] = useState(1);
  const [kind, setKind] = useState("");
  const [status, setStatus] = useState("");

  const fetchPurchases = useCallback(
    async () =>
      unwrap(
        await api.v1.purchases.$get({
          query: {
            page: String(page),
            pageSize: String(PAGE_SIZE),
            ...(q ? { q } : {}),
            ...(kind ? { kind: kind as (typeof KINDS)[number]["value"] } : {}),
            ...(status ? { status: status as "DRAFT" | "POSTED" } : {}),
          },
        }),
      ),
    [q, page, kind, status],
  );
  const purchases = useQuery(fetchPurchases);
  const data = purchases.data;

  if (!canManage) {
    return (
      <>
        <PageHeader title="Compras" />
        <ErrorNote message="Solo propietarios y administradores pueden ver las compras." />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Compras y gastos"
        description="Facturas de proveedores, comprobantes de compras (E41) y gastos menores (E43). Al registrarlas, la mercancía entra al inventario."
        actions={
          <Link
            href="/panel/compras/nueva"
            className="inline-flex items-center rounded-md bg-foreground px-3.5 py-2 text-sm font-medium text-background hover:opacity-90"
          >
            Nueva compra
          </Link>
        }
      />

      <div className="flex flex-wrap items-end gap-3">
        <Field label="Buscar" className="min-w-56 flex-1">
          <Input
            type="search"
            placeholder="NCF, proveedor o RNC/cédula"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        </Field>
        <Field label="Tipo" className="w-60">
          <Select
            value={kind}
            onChange={(e) => {
              setKind(e.target.value);
              setPage(1);
            }}
          >
            <option value="">Todos</option>
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Estado" className="w-40">
          <Select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
          >
            <option value="">Todos</option>
            <option value="DRAFT">Borrador</option>
            <option value="POSTED">Registrada</option>
          </Select>
        </Field>
      </div>

      <ErrorNote message={purchases.error} />

      <div className={tableStyles.wrapper}>
        <table className={tableStyles.table}>
          <thead>
            <tr>
              <th className={tableStyles.th}>Fecha</th>
              <th className={tableStyles.th}>NCF</th>
              <th className={tableStyles.th}>Tipo</th>
              <th className={tableStyles.th}>Proveedor</th>
              <th className={`${tableStyles.th} text-right`}>Total</th>
              <th className={tableStyles.th}>Estado</th>
            </tr>
          </thead>
          <tbody>
            {data?.data.map((p) => (
              <tr
                key={p.id}
                tabIndex={0}
                role="link"
                onClick={() => router.push(`/panel/compras/${p.id}`)}
                onKeyDown={(e) =>
                  e.key === "Enter" && router.push(`/panel/compras/${p.id}`)
                }
                className="cursor-pointer hover:bg-zinc-50 focus:bg-zinc-50 dark:hover:bg-zinc-900 dark:focus:bg-zinc-900"
              >
                <td className={`${tableStyles.td} whitespace-nowrap`}>
                  {formatDate(p.invoiceDate)}
                </td>
                <td className={`${tableStyles.td} font-mono text-xs`}>
                  {p.ncf ?? <span className="text-zinc-500">Sin asignar</span>}
                </td>
                <td className={tableStyles.td}>
                  {p.kindLabel}
                  <div className="text-xs text-zinc-500">{p.expenseLabel}</div>
                </td>
                <td className={tableStyles.td}>
                  {p.supplierName ?? <span className="text-zinc-500">—</span>}
                </td>
                <td className={`${tableStyles.td} text-right tabular-nums`}>
                  {money(p.total, p.currency)}
                </td>
                <td className={tableStyles.td}>
                  <Badge tone={p.status === "POSTED" ? "success" : "neutral"}>
                    {p.status === "POSTED" ? "Registrada" : "Borrador"}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && data.data.length === 0 && (
          <EmptyState>
            {q || kind || status
              ? "Ninguna compra coincide con los filtros."
              : "Aún no hay compras registradas."}
          </EmptyState>
        )}
        {!data && !purchases.error && <EmptyState>Cargando…</EmptyState>}
      </div>

      {data && (
        <Pagination
          page={data.page}
          pageSize={data.pageSize}
          total={data.total}
          onPage={setPage}
        />
      )}
    </>
  );
}
