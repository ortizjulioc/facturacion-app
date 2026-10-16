"use client";

import { useState, type FormEvent } from "react";
import { Badge, Button, EmptyState, ErrorNote, Field, Input, Modal, PageHeader, Select } from "@/components/ui";
import { usePanel } from "@/components/panel-context";
import { api, errorMessage, unwrap } from "@/lib/api";
import { useQuery } from "@/lib/use-query";

async function loadAll() {
  const [branches, terminals] = await Promise.all([
    unwrap(await api.v1.branches.$get()),
    unwrap(await api.v1.terminals.$get({ query: {} })),
  ]);
  return { branches: branches.data, terminals: terminals.data };
}

type Loaded = Awaited<ReturnType<typeof loadAll>>;
type Branch = Loaded["branches"][number];
type Terminal = Loaded["terminals"][number];

export function SucursalesView() {
  const { canManage } = usePanel();
  const { data, error, reload } = useQuery(loadAll);
  const [branchModal, setBranchModal] = useState(false);
  const [terminalFor, setTerminalFor] = useState<Branch | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function run(action: () => Promise<unknown>) {
    setActionError(null);
    try {
      await action();
      reload();
    } catch (e) {
      setActionError(errorMessage(e));
    }
  }

  const toggleBranch = (b: Branch) =>
    run(async () =>
      unwrap(await api.v1.branches[":id"].$patch({ param: { id: b.id }, json: { active: !b.active } })),
    );
  const toggleTerminal = (t: Terminal) =>
    run(async () =>
      unwrap(await api.v1.terminals[":id"].$patch({ param: { id: t.id }, json: { active: !t.active } })),
    );

  return (
    <>
      <PageHeader
        title="Sucursales y cajas"
        description="Cada local tiene una o más cajas. Las secuencias de comprobantes (e-NCF) se asignan por caja."
        actions={canManage && <Button onClick={() => setBranchModal(true)}>Nueva sucursal</Button>}
      />

      <ErrorNote message={error ?? actionError} />
      {!data && !error && <EmptyState>Cargando…</EmptyState>}
      {data && data.branches.length === 0 && (
        <EmptyState>Aún no hay sucursales. Crea la primera para poder registrar cajas.</EmptyState>
      )}

      <div className="space-y-4">
        {data?.branches.map((b) => {
          const terminals = data.terminals.filter((t) => t.branchId === b.id);
          return (
            <section
              key={b.id}
              className={`rounded-lg border border-zinc-200 dark:border-zinc-800 ${b.active ? "" : "opacity-60"}`}
            >
              <header className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
                <div>
                  <h2 className="font-semibold">
                    {b.name} <span className="font-mono text-sm font-normal text-zinc-500">{b.code}</span>
                    {!b.active && (
                      <span className="ml-2">
                        <Badge tone="warning">Inactiva</Badge>
                      </span>
                    )}
                  </h2>
                  {b.address && <p className="text-sm text-zinc-600 dark:text-zinc-400">{b.address}</p>}
                </div>
                {canManage && (
                  <div className="flex gap-1">
                    {b.active && (
                      <Button variant="secondary" onClick={() => setTerminalFor(b)}>
                        Nueva caja
                      </Button>
                    )}
                    <Button variant="ghost" onClick={() => toggleBranch(b)}>
                      {b.active ? "Desactivar" : "Activar"}
                    </Button>
                  </div>
                )}
              </header>
              <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
                {terminals.length === 0 && (
                  <li className="px-4 py-3 text-sm text-zinc-500">Sin cajas.</li>
                )}
                {terminals.map((t) => (
                  <li
                    key={t.id}
                    className={`flex items-center justify-between px-4 py-2.5 text-sm ${t.active ? "" : "opacity-60"}`}
                  >
                    <span>
                      {t.name} <span className="font-mono text-xs text-zinc-500">{t.code}</span>
                      {!t.active && (
                        <span className="ml-2">
                          <Badge tone="warning">Inactiva</Badge>
                        </span>
                      )}
                    </span>
                    {canManage && (
                      <Button variant="ghost" onClick={() => toggleTerminal(t)}>
                        {t.active ? "Desactivar" : "Activar"}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>

      <Modal open={branchModal} onClose={() => setBranchModal(false)} title="Nueva sucursal">
        {branchModal && (
          <BranchForm
            onDone={() => {
              setBranchModal(false);
              reload();
            }}
          />
        )}
      </Modal>

      <Modal
        open={terminalFor !== null}
        onClose={() => setTerminalFor(null)}
        title={`Nueva caja en ${terminalFor?.name ?? ""}`}
      >
        {terminalFor && (
          <TerminalForm
            branch={terminalFor}
            branches={data?.branches.filter((b) => b.active) ?? []}
            onDone={() => {
              setTerminalFor(null);
              reload();
            }}
          />
        )}
      </Modal>
    </>
  );
}

function BranchForm({ onDone }: { onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    const f = new FormData(e.currentTarget);
    try {
      await unwrap(
        await api.v1.branches.$post({
          json: {
            name: String(f.get("name")).trim(),
            code: String(f.get("code")).trim(),
            address: String(f.get("address") ?? "").trim(),
          },
        }),
      );
      onDone();
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="grid grid-cols-3 gap-4">
        <Field label="Nombre" className="col-span-2">
          <Input name="name" required minLength={2} maxLength={120} autoFocus />
        </Field>
        <Field label="Código" hint="Ej: 001">
          <Input name="code" required maxLength={20} />
        </Field>
      </div>
      <Field label="Dirección">
        <Input name="address" maxLength={250} />
      </Field>
      <ErrorNote message={error} />
      <div className="flex justify-end">
        <Button disabled={saving}>{saving ? "Guardando…" : "Crear sucursal"}</Button>
      </div>
    </form>
  );
}

function TerminalForm({
  branch,
  branches,
  onDone,
}: {
  branch: Branch;
  branches: Branch[];
  onDone: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    const f = new FormData(e.currentTarget);
    try {
      await unwrap(
        await api.v1.terminals.$post({
          json: {
            branchId: String(f.get("branchId")),
            name: String(f.get("name")).trim(),
            code: String(f.get("code")).trim(),
          },
        }),
      );
      onDone();
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <Field label="Sucursal">
        <Select name="branchId" defaultValue={branch.id}>
          {branches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </Select>
      </Field>
      <div className="grid grid-cols-3 gap-4">
        <Field label="Nombre" className="col-span-2">
          <Input name="name" required minLength={2} maxLength={120} placeholder="Caja 1" autoFocus />
        </Field>
        <Field label="Código" hint="Ej: C01">
          <Input name="code" required maxLength={20} />
        </Field>
      </div>
      <ErrorNote message={error} />
      <div className="flex justify-end">
        <Button disabled={saving}>{saving ? "Guardando…" : "Crear caja"}</Button>
      </div>
    </form>
  );
}
