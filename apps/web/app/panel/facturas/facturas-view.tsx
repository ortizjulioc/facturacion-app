"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import {
  ECF_LABELS,
  ECF_TYPES,
  formatDocument,
  type DocumentType,
  type EcfType,
} from "@facturacion/core";
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
import { api, unwrap } from "@/lib/api";
import { formatDateTime, money, STATUS_LABELS, statusTone } from "@/lib/format";
import { useDebounced, useQuery } from "@/lib/use-query";

const PAGE_SIZE = 20;
const STATUSES = ["DRAFT", "ISSUED", "SENT", "ACCEPTED", "ACCEPTED_CONDITIONAL", "REJECTED"] as const;

export function FacturasView({ initialStatus = "" }: { initialStatus?: string }) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim());
  const [page, setPage] = useState(1);
  const [type, setType] = useState("");
  const [status, setStatus] = useState(initialStatus);

  const fetchDocs = useCallback(
    async () =>
      unwrap(
        await api.v1.documents.$get({
          query: {
            page: String(page),
            pageSize: String(PAGE_SIZE),
            ...(q ? { q } : {}),
            ...(type ? { type: type as EcfType } : {}),
            ...(status ? { status: status as (typeof STATUSES)[number] } : {}),
          },
        }),
      ),
    [q, page, type, status],
  );
  const docs = useQuery(fetchDocs);
  const data = docs.data;

  return (
    <>
      <PageHeader
        title="Facturas"
        description="Comprobantes fiscales electrónicos (e-CF) emitidos y borradores."
        actions={
          <Link
            href="/panel/facturas/nueva"
            className="inline-flex items-center rounded-md bg-foreground px-3.5 py-2 text-sm font-medium text-background hover:opacity-90"
          >
            Nueva factura
          </Link>
        }
      />

      <div className="flex flex-wrap items-end gap-3">
        <Field label="Buscar" className="min-w-56 flex-1">
          <Input
            type="search"
            placeholder="e-NCF, cliente o RNC/cédula"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        </Field>
        <Field label="Tipo" className="w-52">
          <Select
            value={type}
            onChange={(e) => {
              setType(e.target.value);
              setPage(1);
            }}
          >
            <option value="">Todos</option>
            {ECF_TYPES.map((t) => (
              <option key={t} value={t}>
                {t} · {ECF_LABELS[t]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Estado" className="w-44">
          <Select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
          >
            <option value="">Todos</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <ErrorNote message={docs.error} />

      <div className={tableStyles.wrapper}>
        <table className={tableStyles.table}>
          <thead>
            <tr>
              <th className={tableStyles.th}>Número</th>
              <th className={tableStyles.th}>Tipo</th>
              <th className={tableStyles.th}>Cliente</th>
              <th className={tableStyles.th}>Fecha</th>
              <th className={`${tableStyles.th} text-right`}>Total</th>
              <th className={tableStyles.th}>Estado</th>
            </tr>
          </thead>
          <tbody>
            {data?.data.map((d) => (
              <tr
                key={d.id}
                tabIndex={0}
                role="link"
                onClick={() => router.push(`/panel/facturas/${d.id}`)}
                onKeyDown={(e) =>
                  e.key === "Enter" && router.push(`/panel/facturas/${d.id}`)
                }
                className="cursor-pointer hover:bg-zinc-50 focus:bg-zinc-50 dark:hover:bg-zinc-900 dark:focus:bg-zinc-900"
              >
                <td className={`${tableStyles.td} font-mono text-xs`}>
                  {d.encf ?? <span className="text-zinc-500">Borrador</span>}
                </td>
                <td className={tableStyles.td}>{ECF_LABELS[d.type]}</td>
                <td className={tableStyles.td}>
                  {d.buyerName ?? <span className="text-zinc-500">Consumidor final</span>}
                  {d.buyerDocType && d.buyerDocNumber && (
                    <div className="text-xs text-zinc-500">
                      {formatDocument(d.buyerDocType as DocumentType, d.buyerDocNumber)}
                    </div>
                  )}
                </td>
                <td className={`${tableStyles.td} whitespace-nowrap`}>
                  {formatDateTime(d.issuedAt ?? d.createdAt)}
                </td>
                <td className={`${tableStyles.td} text-right tabular-nums`}>
                  {money(d.total, d.currency)}
                </td>
                <td className={tableStyles.td}>
                  <Badge tone={statusTone(d.status)}>
                    {STATUS_LABELS[d.status] ?? d.status}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && data.data.length === 0 && (
          <EmptyState>
            {q || type || status
              ? "Ningún comprobante coincide con los filtros."
              : "Aún no hay comprobantes."}
          </EmptyState>
        )}
        {!data && !docs.error && <EmptyState>Cargando…</EmptyState>}
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
