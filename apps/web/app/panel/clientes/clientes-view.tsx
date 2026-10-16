"use client";

import { useCallback, useState, type FormEvent } from "react";
import { DOCUMENT_TYPES, formatDocument, type DocumentType } from "@facturacion/core";
import {
  Badge,
  Button,
  Checkbox,
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
import { usePanel } from "@/components/panel-context";
import { api, errorMessage, unwrap } from "@/lib/api";
import { useDebounced, useQuery } from "@/lib/use-query";

const PAGE_SIZE = 20;
const DOCUMENT_LABELS: Record<DocumentType, string> = {
  RNC: "RNC",
  CEDULA: "Cédula",
  PASAPORTE: "Pasaporte",
};

async function loadCustomers(params: { q: string; page: number; showInactive: boolean }) {
  return unwrap(
    await api.v1.customers.$get({
      query: {
        pageSize: String(PAGE_SIZE),
        page: String(params.page),
        ...(params.q ? { q: params.q } : {}),
        ...(params.showInactive ? {} : { active: "true" }),
      },
    }),
  );
}

type Customer = Awaited<ReturnType<typeof loadCustomers>>["data"][number];

export function ClientesView() {
  const { canManage } = usePanel();
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim());
  const [page, setPage] = useState(1);
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<Customer | "new" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const fetchCustomers = useCallback(
    () => loadCustomers({ q, page, showInactive }),
    [q, page, showInactive],
  );
  const customers = useQuery(fetchCustomers);
  const data = customers.data;

  async function toggleActive(c: Customer) {
    setActionError(null);
    try {
      await unwrap(
        await api.v1.customers[":id"].$patch({ param: { id: c.id }, json: { active: !c.active } }),
      );
      customers.reload();
    } catch (e) {
      setActionError(errorMessage(e));
    }
  }

  return (
    <>
      <PageHeader
        title="Clientes"
        description="Compradores a quienes facturas. Con RNC o cédula podrás emitir comprobantes de crédito fiscal."
        actions={
          // Los miembros de caja también pueden registrar clientes (lo permite la API).
          <Button onClick={() => setEditing("new")}>Nuevo cliente</Button>
        }
      />

      <div className="flex flex-wrap items-end gap-3">
        <Field label="Buscar" className="min-w-56 flex-1">
          <Input
            type="search"
            placeholder="Nombre, RNC/cédula o correo"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        </Field>
        <div className="pb-2">
          <Checkbox
            label="Mostrar inactivos"
            checked={showInactive}
            onChange={(e) => {
              setShowInactive(e.target.checked);
              setPage(1);
            }}
          />
        </div>
      </div>

      <ErrorNote message={customers.error ?? actionError} />

      <div className={tableStyles.wrapper}>
        <table className={tableStyles.table}>
          <thead>
            <tr>
              <th className={tableStyles.th}>Cliente</th>
              <th className={tableStyles.th}>Documento</th>
              <th className={tableStyles.th}>Contacto</th>
              <th className={tableStyles.th} />
            </tr>
          </thead>
          <tbody>
            {data?.data.map((c) => (
              <tr key={c.id} className={c.active ? "" : "opacity-60"}>
                <td className={tableStyles.td}>
                  <span className="font-medium">{c.name}</span>
                  {!c.active && (
                    <span className="ml-2">
                      <Badge tone="warning">Inactivo</Badge>
                    </span>
                  )}
                </td>
                <td className={`${tableStyles.td} tabular-nums`}>
                  {c.documentType && c.documentNumber ? (
                    <>
                      <span className="text-xs text-zinc-500">
                        {DOCUMENT_LABELS[c.documentType as DocumentType]}{" "}
                      </span>
                      {formatDocument(c.documentType as DocumentType, c.documentNumber)}
                    </>
                  ) : (
                    <span className="text-zinc-500">Consumidor final</span>
                  )}
                </td>
                <td className={tableStyles.td}>
                  {c.email ?? "—"}
                  {c.phone && <div className="text-xs text-zinc-500">{c.phone}</div>}
                </td>
                <td className={`${tableStyles.td} whitespace-nowrap text-right`}>
                  <Button variant="ghost" onClick={() => setEditing(c)}>
                    Editar
                  </Button>
                  {canManage && (
                    <Button variant="ghost" onClick={() => toggleActive(c)}>
                      {c.active ? "Desactivar" : "Activar"}
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && data.data.length === 0 && (
          <EmptyState>{q ? "Ningún cliente coincide con la búsqueda." : "Aún no hay clientes."}</EmptyState>
        )}
        {!data && !customers.error && <EmptyState>Cargando…</EmptyState>}
      </div>

      {data && (
        <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
      )}

      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === "new" ? "Nuevo cliente" : "Editar cliente"}
      >
        {editing && (
          <CustomerForm
            customer={editing === "new" ? null : editing}
            onDone={() => {
              setEditing(null);
              customers.reload();
            }}
          />
        )}
      </Modal>
    </>
  );
}

function CustomerForm({ customer, onDone }: { customer: Customer | null; onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    const f = new FormData(e.currentTarget);
    const text = (name: string) => String(f.get(name) ?? "").trim();
    const documentType = text("documentType");
    const email = text("email");

    const json = {
      name: text("name"),
      documentType: documentType ? (documentType as DocumentType) : null,
      documentNumber: documentType ? text("documentNumber") : null,
      email: email || null,
      phone: text("phone"),
      address: text("address"),
    };

    try {
      if (customer) {
        await unwrap(await api.v1.customers[":id"].$patch({ param: { id: customer.id }, json }));
      } else {
        await unwrap(await api.v1.customers.$post({ json }));
      }
      onDone();
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <Field label="Nombre o razón social">
        <Input name="name" required maxLength={200} defaultValue={customer?.name} autoFocus />
      </Field>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Tipo de documento">
          <Select name="documentType" defaultValue={customer?.documentType ?? ""}>
            <option value="">Sin documento (consumidor final)</option>
            {DOCUMENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {DOCUMENT_LABELS[t]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Número">
          <Input
            name="documentNumber"
            defaultValue={
              customer?.documentType && customer.documentNumber
                ? formatDocument(customer.documentType as DocumentType, customer.documentNumber)
                : ""
            }
          />
        </Field>
        <Field label="Correo">
          <Input name="email" type="email" defaultValue={customer?.email ?? ""} />
        </Field>
        <Field label="Teléfono">
          <Input name="phone" type="tel" defaultValue={customer?.phone ?? ""} />
        </Field>
      </div>
      <Field label="Dirección">
        <Input name="address" maxLength={250} defaultValue={customer?.address ?? ""} />
      </Field>
      <ErrorNote message={error} />
      <div className="flex justify-end">
        <Button disabled={saving}>{saving ? "Guardando…" : "Guardar"}</Button>
      </div>
    </form>
  );
}
