"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useState, type FormEvent } from "react";
import { useDialogs } from "@/components/dialogs";
import { usePanel } from "@/components/panel-context";
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
  Select,
  tableStyles,
} from "@/components/ui";
import { api, errorMessage, unwrap } from "@/lib/api";
import { money } from "@/lib/format";
import { useInterval } from "@/lib/use-interval";
import { useQuery } from "@/lib/use-query";

type Table = Awaited<ReturnType<typeof loadTables>>["data"][number];

async function loadTables(all = false) {
  return unwrap(await api.v1.restaurant.tables.$get({ query: all ? { all: "true" } : {} }));
}

const linkButton =
  "inline-flex items-center justify-center rounded-md border border-zinc-300 px-3.5 py-2 text-sm font-medium transition hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900";

/** "12 min", "1 h 05 min". */
function elapsed(iso: string | Date) {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60_000));
  return minutes < 60
    ? `${minutes} min`
    : `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}

export function SalonView() {
  const router = useRouter();
  const { canManage } = usePanel();
  const { toast } = useDialogs();
  const tables = useQuery(useCallback(() => loadTables(), []));
  const [managing, setManaging] = useState(false);
  const [openFor, setOpenFor] = useState<Table | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // El salón se refresca solo: así se ve cuándo una mesa tiene pedidos listos.
  useInterval(tables.reload, 15_000);

  async function pick(table: Table) {
    setActionError(null);
    if (table.order) {
      router.push(`/panel/restaurante/comanda/${table.order.id}`);
      return;
    }
    setOpenFor(table);
  }

  async function open(table: Table, covers: number | null) {
    setOpening(table.id);
    try {
      const res = await unwrap(
        await api.v1.restaurant.orders.$post({ json: { tableId: table.id, covers } }),
      );
      router.push(`/panel/restaurante/comanda/${res.data.id}`);
    } catch (e) {
      setActionError(errorMessage(e));
      setOpening(null);
      tables.reload();
    }
  }

  const list = tables.data?.data ?? [];
  const zones = [...new Set(list.map((t) => t.zone ?? ""))].sort((a, b) => a.localeCompare(b, "es"));
  const busy = list.filter((t) => t.order).length;

  return (
    <>
      <PageHeader
        title="Restaurante"
        description={
          tables.data ? `${busy} de ${list.length} mesas ocupadas` : "Mesas, pedidos y cobro por mesa."
        }
        actions={
          <>
            <Link href="/panel/restaurante/cocina" className={linkButton}>
              Cocina y bar
            </Link>
            {canManage && (
              <Button variant="secondary" onClick={() => setManaging(true)}>
                Administrar mesas
              </Button>
            )}
          </>
        }
      />

      <ErrorNote message={tables.error ?? actionError} />

      {tables.data && list.length === 0 && (
        <EmptyState>
          {canManage
            ? "Aún no hay mesas. Usa «Administrar mesas» para crearlas."
            : "Aún no hay mesas. Pide a un administrador que las cree."}
        </EmptyState>
      )}
      {!tables.data && !tables.error && <EmptyState>Cargando…</EmptyState>}

      {zones.map((zone) => (
        <section key={zone || "_"} className="space-y-3">
          {zones.length > 1 && (
            <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
              {zone || "Sin zona"}
            </h2>
          )}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {list
              .filter((t) => (t.zone ?? "") === zone)
              .map((t) => (
                <button
                  key={t.id}
                  onClick={() => pick(t)}
                  disabled={opening === t.id}
                  className={`flex min-h-28 flex-col items-start gap-1 rounded-lg border p-3 text-left transition hover:shadow-md disabled:opacity-60 ${
                    t.order
                      ? "border-amber-400 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/40"
                      : "border-zinc-200 hover:border-zinc-400 dark:border-zinc-800"
                  }`}
                >
                  <span className="text-base font-semibold">{t.name}</span>
                  {t.order ? (
                    <>
                      <span className="text-sm tabular-nums">{money(t.order.total)}</span>
                      <span className="text-xs text-zinc-600 dark:text-zinc-400">
                        {elapsed(t.order.openedAt)}
                        {t.order.covers ? ` · ${t.order.covers} pers.` : ""}
                      </span>
                      <span className="mt-auto flex flex-wrap gap-1">
                        {t.order.unsent > 0 && <Badge>{t.order.unsent} sin enviar</Badge>}
                        {t.order.waiting > 0 && (
                          <Badge tone="warning">{t.order.waiting} en preparación</Badge>
                        )}
                        {t.order.ready > 0 && <Badge tone="success">{t.order.ready} listos</Badge>}
                      </span>
                    </>
                  ) : (
                    <span className="text-xs text-zinc-500">Libre · {t.seats} puestos</span>
                  )}
                </button>
              ))}
          </div>
        </section>
      ))}

      <Modal
        open={openFor !== null}
        onClose={() => setOpenFor(null)}
        title={`Abrir ${openFor?.name ?? ""}`}
      >
        {openFor && (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              const raw = String(new FormData(e.currentTarget).get("covers") ?? "").trim();
              const table = openFor;
              setOpenFor(null);
              void open(table, raw ? Number(raw) : null);
            }}
          >
            <Field label="Comensales (opcional)">
              <Input name="covers" type="number" min={1} max={200} step={1} autoFocus />
            </Field>
            <div className="flex justify-end">
              <Button>Abrir mesa</Button>
            </div>
          </form>
        )}
      </Modal>

      <Modal open={managing} onClose={() => setManaging(false)} title="Administrar mesas">
        {managing && (
          <TablesManager
            onChange={() => {
              tables.reload();
              toast("Mesas actualizadas");
            }}
          />
        )}
      </Modal>
    </>
  );
}

function TablesManager({ onChange }: { onChange: () => void }) {
  const { toast } = useDialogs();
  const all = useQuery(useCallback(() => loadTables(true), []));
  const branches = useQuery(
    useCallback(
      async () => (await unwrap(await api.v1.branches.$get())).data.filter((b) => b.active),
      [],
    ),
  );
  const [error, setError] = useState<string | null>(null);
  const [branchId, setBranchId] = useState("");
  const branch = branchId || branches.data?.[0]?.id || "";

  async function run(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
      all.reload();
      onChange();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  const text = (f: FormData, k: string) => String(f.get(k) ?? "").trim();

  function addOne(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    void run(async () => {
      await unwrap(
        await api.v1.restaurant.tables.$post({
          json: {
            branchId: branch,
            name: text(f, "name"),
            zone: text(f, "zone"),
            seats: Number(text(f, "seats")) || 4,
          },
        }),
      );
      form.reset();
    });
  }

  function addBulk(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    void run(async () => {
      const res = await unwrap(
        await api.v1.restaurant.tables.bulk.$post({
          json: {
            branchId: branch,
            prefix: text(f, "prefix") || "Mesa",
            count: Number(text(f, "count")),
            zone: text(f, "zone"),
            seats: Number(text(f, "seats")) || 4,
          },
        }),
      );
      toast(
        `${res.data.created} creadas${res.data.skipped ? `, ${res.data.skipped} ya existían` : ""}`,
      );
      form.reset();
    });
  }

  return (
    <div className="space-y-5">
      {(branches.data?.length ?? 0) > 1 && (
        <Field label="Sucursal">
          <Select value={branch} onChange={(e) => setBranchId(e.target.value)}>
            {branches.data?.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        </Field>
      )}

      <form
        onSubmit={addBulk}
        className="space-y-3 rounded-md border border-zinc-200 p-3 dark:border-zinc-800"
      >
        <p className="text-sm font-medium">Crear varias mesas</p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Nombre base">
            <Input name="prefix" defaultValue="Mesa" maxLength={30} />
          </Field>
          <Field label="Cantidad">
            <Input name="count" type="number" min={1} max={100} required defaultValue={10} />
          </Field>
          <Field label="Zona (opcional)">
            <Input name="zone" maxLength={40} placeholder="Salón, Terraza…" />
          </Field>
          <Field label="Puestos">
            <Input name="seats" type="number" min={1} max={50} defaultValue={4} />
          </Field>
        </div>
        <Button disabled={!branch}>Crear</Button>
      </form>

      <form
        onSubmit={addOne}
        className="space-y-3 rounded-md border border-zinc-200 p-3 dark:border-zinc-800"
      >
        <p className="text-sm font-medium">Agregar una mesa</p>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Nombre">
            <Input name="name" required maxLength={40} placeholder="Barra 1" />
          </Field>
          <Field label="Zona">
            <Input name="zone" maxLength={40} />
          </Field>
          <Field label="Puestos">
            <Input name="seats" type="number" min={1} max={50} defaultValue={4} />
          </Field>
        </div>
        <Button disabled={!branch}>Agregar</Button>
      </form>

      <ErrorNote message={error ?? all.error} />

      <div className={tableStyles.wrapper}>
        <table className={tableStyles.table}>
          <tbody>
            {all.data?.data.map((t) => (
              <tr key={t.id} className={t.active ? "" : "opacity-60"}>
                <td className={tableStyles.td}>
                  {t.name}
                  <span className="text-xs text-zinc-500">
                    {t.zone ? ` · ${t.zone}` : ""} · {t.seats} puestos
                  </span>
                </td>
                <td className={`${tableStyles.td} text-right`}>
                  <Checkbox
                    label="Activa"
                    checked={t.active}
                    onChange={(e) =>
                      void run(async () =>
                        unwrap(
                          await api.v1.restaurant.tables[":id"].$patch({
                            param: { id: t.id },
                            json: { active: e.target.checked },
                          }),
                        ),
                      )
                    }
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {all.data && all.data.data.length === 0 && <EmptyState>Sin mesas.</EmptyState>}
      </div>
    </div>
  );
}
