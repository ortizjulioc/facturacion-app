"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState, type FormEvent } from "react";
import {
  calculateDocument,
  fromCents,
  toCents,
  toMilli,
  type TaxCode,
} from "@facturacion/core";
import { useDialogs } from "@/components/dialogs";
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
} from "@/components/ui";
import { api, errorMessage, expectOk, unwrap } from "@/lib/api";
import { formatDateTime, money, PAYMENT_LABELS, PAYMENT_METHODS } from "@/lib/format";
import { useDebounced, useQuery } from "@/lib/use-query";

type Order = Awaited<ReturnType<typeof loadOrder>>;
type Item = Order["items"][number];

async function loadOrder(id: string) {
  return (await unwrap(await api.v1.restaurant.orders[":id"].$get({ param: { id } }))).data;
}

const ITEM_STATUS: Record<string, { label: string; tone: "neutral" | "success" | "warning" }> = {
  PENDING: { label: "Sin enviar", tone: "neutral" },
  SENT: { label: "En preparación", tone: "warning" },
  READY: { label: "Listo", tone: "success" },
  VOID: { label: "Anulado", tone: "neutral" },
};

const linkButton =
  "inline-flex items-center justify-center rounded-md border border-zinc-300 px-3.5 py-2 text-sm font-medium transition hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900";

export function ComandaView({ id }: { id: string }) {
  const router = useRouter();
  const { prompt, toast } = useDialogs();
  const order = useQuery(useCallback(() => loadOrder(id), [id]));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [billing, setBilling] = useState(false);
  const [transferring, setTransferring] = useState(false);

  /** Ejecuta una operación sobre la comanda y refresca; los errores se muestran arriba. */
  async function run(action: () => Promise<unknown>, done?: string) {
    setError(null);
    setBusy(true);
    try {
      await action();
      if (done) toast(done);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      order.reload();
    }
  }

  const o = order.data;
  const open = o?.status === "OPEN";
  const pending = o?.items.filter((i) => i.status === "PENDING").length ?? 0;
  const toCharge = o?.items.filter((i) => Number(i.remaining) > 0).length ?? 0;

  const param = { id };
  const add = (productId: string) =>
    run(async () =>
      unwrap(
        await api.v1.restaurant.orders[":id"].items.$post({
          param,
          json: { productId, quantity: "1" },
        }),
      ),
    );

  const changeQuantity = (item: Item, delta: number) => {
    const next = Number(item.quantity) + delta;
    if (next < 1) return removeItem(item);
    return run(async () =>
      unwrap(
        await api.v1.restaurant.orders[":id"].items[":itemId"].$patch({
          param: { ...param, itemId: item.id },
          json: { quantity: String(next) },
        }),
      ),
    );
  };

  const removeItem = (item: Item) =>
    run(async () =>
      unwrap(
        await api.v1.restaurant.orders[":id"].items[":itemId"].void.$post({
          param: { ...param, itemId: item.id },
          json: {},
        }),
      ),
    );

  async function voidSent(item: Item) {
    const reason = await prompt({
      title: `Anular "${item.name}"`,
      label: "Motivo",
      confirmLabel: "Anular",
    });
    if (!reason) return;
    await run(async () =>
      unwrap(
        await api.v1.restaurant.orders[":id"].items[":itemId"].void.$post({
          param: { ...param, itemId: item.id },
          json: { reason },
        }),
      ),
    );
  }

  async function editNotes(item: Item) {
    const notes = await prompt({
      title: `Notas de "${item.name}"`,
      label: "Ej.: sin cebolla, término medio",
      initialValue: item.notes ?? "",
      confirmLabel: "Guardar",
    });
    if (notes === null) return;
    await run(async () =>
      unwrap(
        await api.v1.restaurant.orders[":id"].items[":itemId"].$patch({
          param: { ...param, itemId: item.id },
          json: { notes },
        }),
      ),
    );
  }

  async function send() {
    setError(null);
    setBusy(true);
    try {
      const res = await unwrap(await api.v1.restaurant.orders[":id"].send.$post({ param }));
      const count = res.data.ticket.stations.reduce((n, s) => n + s.items.length, 0);
      toast(`${count} producto${count === 1 ? "" : "s"} enviado${count === 1 ? "" : "s"} a preparación`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      order.reload();
    }
  }

  async function cancel() {
    if (!o) return;
    const reason = await prompt({
      title: `Cancelar la comanda de ${o.table.name}`,
      label: "Motivo",
      confirmLabel: "Cancelar comanda",
    });
    if (!reason) return;
    setError(null);
    try {
      await expectOk(await api.v1.restaurant.orders[":id"].cancel.$post({ param, json: { reason } }));
      toast("Comanda cancelada");
      router.push("/panel/restaurante");
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <>
      <PageHeader
        title={o ? `${o.table.name} · Comanda #${o.number}` : "Comanda"}
        description={
          o
            ? `${o.table.zone ? `${o.table.zone} · ` : ""}${o.covers ? `${o.covers} comensales · ` : ""}abierta ${formatDateTime(o.openedAt)}`
            : undefined
        }
        actions={
          <>
            <Link href="/panel/restaurante" className={linkButton}>
              Salón
            </Link>
            {open && (
              <Button variant="secondary" onClick={() => setTransferring(true)}>
                Cambiar de mesa
              </Button>
            )}
            {open && (
              <Button variant="ghost" onClick={cancel}>
                Cancelar comanda
              </Button>
            )}
          </>
        }
      />

      <ErrorNote message={order.error ?? error} />
      {o && !open && (
        <p className="rounded-md bg-zinc-100 px-3 py-2 text-sm dark:bg-zinc-900">
          Esta comanda está {o.status === "CLOSED" ? "cerrada (cobrada)" : "cancelada"}
          {o.cancelReason ? `: ${o.cancelReason}` : ""}.
        </p>
      )}

      {!o && !order.error && <EmptyState>Cargando…</EmptyState>}

      {o && (
        <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
          {open ? <ProductPicker onPick={add} disabled={busy} /> : <div />}

          <section className="space-y-4">
            <ul className="divide-y divide-zinc-200 rounded-md border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
              {o.items.length === 0 && <EmptyState>Aún no hay productos.</EmptyState>}
              {o.items.map((i) => (
                <ItemRow
                  key={i.id}
                  item={i}
                  editable={open}
                  disabled={busy}
                  onDelta={(d) => changeQuantity(i, d)}
                  onNotes={() => editNotes(i)}
                  onRemove={() => removeItem(i)}
                  onVoid={() => voidSent(i)}
                />
              ))}
            </ul>

            <dl className="space-y-1 rounded-md border border-zinc-200 p-3 text-sm dark:border-zinc-800">
              <Row label="Subtotal" value={o.totals.subtotal} />
              <Row label="ITBIS" value={o.totals.tax} />
              <Row label="Total" value={o.totals.total} strong />
              <Row label="Propina legal (10 %)" value={o.totals.propina} />
              <Row label="Total con propina" value={o.totals.totalWithTip} strong />
            </dl>

            {open && (
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" disabled={busy || pending === 0} onClick={send}>
                  Enviar a cocina{pending > 0 ? ` (${pending})` : ""}
                </Button>
                <Button disabled={busy || toCharge === 0} onClick={() => setBilling(true)}>
                  Cobrar
                </Button>
              </div>
            )}
          </section>
        </div>
      )}

      <Modal open={billing} onClose={() => setBilling(false)} title="Cobrar">
        {billing && o && (
          <BillDialog
            order={o}
            onClose={() => setBilling(false)}
            onBilled={order.reload}
          />
        )}
      </Modal>

      <Modal open={transferring} onClose={() => setTransferring(false)} title="Cambiar de mesa">
        {transferring && o && (
          <TransferDialog
            orderId={o.id}
            current={o.table.id}
            onDone={() => {
              setTransferring(false);
              toast("Comanda cambiada de mesa");
              order.reload();
            }}
          />
        )}
      </Modal>
    </>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between ${strong ? "font-semibold" : "text-zinc-600 dark:text-zinc-400"}`}>
      <dt>{label}</dt>
      <dd className="tabular-nums">{money(value)}</dd>
    </div>
  );
}

function ItemRow({
  item: i,
  editable,
  disabled,
  onDelta,
  onNotes,
  onRemove,
  onVoid,
}: {
  item: Item;
  editable: boolean;
  disabled: boolean;
  onDelta: (delta: number) => void;
  onNotes: () => void;
  onRemove: () => void;
  onVoid: () => void;
}) {
  const status = ITEM_STATUS[i.status] ?? ITEM_STATUS.PENDING!;
  const billed = Number(i.billedQuantity) > 0;
  const voided = i.status === "VOID";
  return (
    <li className={`space-y-1 px-3 py-2.5 text-sm ${voided ? "opacity-50" : ""}`}>
      <div className="flex items-start justify-between gap-2">
        <span className={voided ? "line-through" : "font-medium"}>
          {i.quantity}× {i.name}
        </span>
        <span className="tabular-nums">{money(i.pendingTotal)}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
        <Badge tone={status.tone}>{status.label}</Badge>
        {billed && !voided && <span>cobrado {i.billedQuantity}</span>}
        {i.notes && <span className="text-amber-700 dark:text-amber-400">{i.notes}</span>}
        {voided && i.voidReason && <span>{i.voidReason}</span>}
      </div>
      {editable && !voided && !billed && (
        <div className="flex flex-wrap items-center gap-1 pt-1">
          {i.status === "PENDING" && (
            <>
              <Button variant="secondary" className="px-2.5 py-1" disabled={disabled} onClick={() => onDelta(-1)} aria-label="Quitar uno">
                −
              </Button>
              <Button variant="secondary" className="px-2.5 py-1" disabled={disabled} onClick={() => onDelta(1)} aria-label="Agregar uno">
                +
              </Button>
              <Button variant="ghost" className="px-2.5 py-1" disabled={disabled} onClick={onNotes}>
                Nota
              </Button>
              <Button variant="ghost" className="px-2.5 py-1" disabled={disabled} onClick={onRemove}>
                Quitar
              </Button>
            </>
          )}
          {i.status !== "PENDING" && (
            <Button variant="ghost" className="px-2.5 py-1" disabled={disabled} onClick={onVoid}>
              Anular
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

function ProductPicker({ onPick, disabled }: { onPick: (productId: string) => void; disabled: boolean }) {
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim(), 250);
  const [categoryId, setCategoryId] = useState("");

  const categories = useQuery(
    useCallback(async () => (await unwrap(await api.v1.categories.$get())).data, []),
  );
  const products = useQuery(
    useCallback(
      async () =>
        (
          await unwrap(
            await api.v1.products.$get({
              query: {
                active: "true",
                pageSize: "60",
                ...(q ? { q } : {}),
                ...(categoryId ? { categoryId } : {}),
              },
            }),
          )
        ).data,
      [q, categoryId],
    ),
  );

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap gap-3">
        <Input
          type="search"
          aria-label="Buscar producto"
          placeholder="Buscar producto…"
          className="min-w-48 flex-1"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Select
          aria-label="Categoría"
          className="w-48"
          value={categoryId}
          onChange={(e) => setCategoryId(e.target.value)}
        >
          <option value="">Todas las categorías</option>
          {categories.data?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </div>
      <ErrorNote message={products.error} />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {products.data?.map((p) => (
          <button
            key={p.id}
            disabled={disabled}
            onClick={() => onPick(p.id)}
            className="flex min-h-20 flex-col items-start justify-between rounded-lg border border-zinc-200 p-3 text-left text-sm transition hover:border-zinc-400 hover:shadow disabled:opacity-60 dark:border-zinc-800"
          >
            <span className="font-medium">{p.name}</span>
            <span className="tabular-nums text-zinc-600 dark:text-zinc-400">{money(p.price)}</span>
          </button>
        ))}
      </div>
      {products.data && products.data.length === 0 && (
        <EmptyState>Ningún producto coincide.</EmptyState>
      )}
    </section>
  );
}

function TransferDialog({
  orderId,
  current,
  onDone,
}: {
  orderId: string;
  current: string;
  onDone: () => void;
}) {
  const tables = useQuery(
    useCallback(async () => (await unwrap(await api.v1.restaurant.tables.$get({ query: {} }))).data, []),
  );
  const [error, setError] = useState<string | null>(null);
  const free = tables.data?.filter((t) => !t.order && t.id !== current) ?? [];

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const tableId = String(new FormData(e.currentTarget).get("tableId") ?? "");
    setError(null);
    try {
      await unwrap(
        await api.v1.restaurant.orders[":id"].transfer.$post({
          param: { id: orderId },
          json: { tableId },
        }),
      );
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label="Mesa de destino">
        <Select name="tableId" required defaultValue="">
          <option value="" disabled>
            Elige una mesa libre
          </option>
          {free.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
              {t.zone ? ` · ${t.zone}` : ""}
            </option>
          ))}
        </Select>
      </Field>
      {tables.data && free.length === 0 && (
        <p className="text-sm text-zinc-500">No hay mesas libres.</p>
      )}
      <ErrorNote message={error ?? tables.error} />
      <div className="flex justify-end">
        <Button disabled={free.length === 0}>Cambiar</Button>
      </div>
    </form>
  );
}

type PaymentRow = { key: number; method: string; amount: string };

function BillDialog({
  order,
  onClose,
  onBilled,
}: {
  order: Order;
  onClose: () => void;
  onBilled: () => void;
}) {
  const router = useRouter();
  const payable = order.items.filter((i) => Number(i.remaining) > 0);
  // Cantidad a cobrar de cada producto: por defecto todo lo pendiente (se puede bajar para dividir la cuenta).
  const [qty, setQty] = useState<Record<string, string>>(() =>
    Object.fromEntries(payable.map((i) => [i.id, i.remaining])),
  );
  const [included, setIncluded] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(payable.map((i) => [i.id, true])),
  );
  const [tip, setTip] = useState(true);
  const [type, setType] = useState<"E32" | "E31">("E32");
  const [customer, setCustomer] = useState<{ id: string; label: string } | null>(null);
  const [payments, setPayments] = useState<PaymentRow[]>([{ key: 1, method: "CASH", amount: "" }]);
  const [typed, setTyped] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ id: string; encf: string | null; total: string; closed: boolean } | null>(null);

  const selection = payable
    .filter((i) => included[i.id])
    .map((i) => ({ item: i, quantity: (qty[i.id] ?? "").replace(",", ".").trim() }));

  const total = useMemo(() => {
    try {
      const lines = selection.map(({ item, quantity }) => ({
        unitPrice: toCents(item.unitPrice),
        quantity: toMilli(quantity),
        tax: item.tax as TaxCode,
        priceIncludesTax: item.priceIncludesTax,
      }));
      if (lines.length === 0 || lines.some((l) => l.quantity <= 0n)) return null;
      const t = calculateDocument({ lines, propinaLegal: tip });
      return { total: t.total, propina: t.propinaLegal, tax: t.totalTax, subtotal: t.subtotal };
    } catch {
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qty, included, tip]);

  // Con un solo pago y sin tocar el monto, se rellena solo con el total.
  const autoAmount = total ? fromCents(total.total) : "";
  const shown = (p: PaymentRow) => (payments.length === 1 && !typed ? autoAmount : p.amount);
  let paid = 0n;
  try {
    paid = payments.reduce((s, p) => s + (shown(p) ? toCents(shown(p).replace(",", ".")) : 0n), 0n);
  } catch {
    paid = -1n;
  }
  const balanced = total !== null && paid === total.total;
  const needsRnc = type === "E31" && !customer;
  const isPartial = selection.length !== payable.length || selection.some(({ item, quantity }) => quantity !== item.remaining);

  async function submit() {
    if (!total) return;
    setError(null);
    setSaving(true);
    try {
      const res = await unwrap(
        await api.v1.restaurant.orders[":id"].bill.$post({
          param: { id: order.id },
          json: {
            ...(isPartial
              ? { items: selection.map(({ item, quantity }) => ({ itemId: item.id, quantity })) }
              : {}),
            type,
            customerId: customer?.id ?? null,
            propinaLegal: tip,
            payments: payments.map((p) => ({
              method: p.method as "CASH",
              amount: shown(p).replace(",", "."),
            })),
          },
        }),
      );
      setResult({
        id: res.data.document.id,
        encf: res.data.document.encf,
        total: res.data.document.totals.total,
        closed: res.data.closed,
      });
      onBilled();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  if (result) {
    return (
      <div className="space-y-4">
        <p className="text-sm">
          Cobro registrado: <span className="font-mono">{result.encf}</span> por{" "}
          <span className="font-semibold">{money(result.total)}</span>.
          {result.closed ? " La mesa quedó libre." : " Aún quedan productos por cobrar en la mesa."}
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          <Link href={`/panel/facturas/${result.id}`} className={linkButton}>
            Ver factura
          </Link>
          <Button
            onClick={() => {
              if (result.closed) router.push("/panel/restaurante");
              else onClose();
            }}
          >
            {result.closed ? "Volver al salón" : "Seguir en la mesa"}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <p className="mb-2 text-sm font-medium">Qué se cobra</p>
        <ul className="divide-y divide-zinc-200 rounded-md border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
          {payable.map((i) => (
            <li key={i.id} className="flex items-center gap-2 px-3 py-2 text-sm">
              <input
                type="checkbox"
                aria-label={`Cobrar ${i.name}`}
                className="h-4 w-4"
                checked={included[i.id] ?? false}
                onChange={(e) => setIncluded((s) => ({ ...s, [i.id]: e.target.checked }))}
              />
              <span className="flex-1">{i.name}</span>
              <Input
                aria-label={`Cantidad de ${i.name}`}
                className="w-20 text-right"
                inputMode="decimal"
                value={qty[i.id] ?? ""}
                disabled={!included[i.id]}
                onChange={(e) => setQty((s) => ({ ...s, [i.id]: e.target.value }))}
              />
              <span className="w-12 text-xs text-zinc-500">de {i.remaining}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Comprobante">
          <Select value={type} onChange={(e) => setType(e.target.value as "E32" | "E31")}>
            <option value="E32">Consumo (E32)</option>
            <option value="E31">Crédito fiscal (E31)</option>
          </Select>
        </Field>
        <div className="flex items-end pb-2">
          <Checkbox label="Propina legal (10 %)" checked={tip} onChange={(e) => setTip(e.target.checked)} />
        </div>
      </div>

      <CustomerPicker value={customer} requireRnc={type === "E31"} onChange={setCustomer} />

      {total && (
        <dl className="space-y-1 rounded-md border border-zinc-200 p-3 text-sm dark:border-zinc-800">
          <Row label="Subtotal" value={fromCents(total.subtotal)} />
          <Row label="ITBIS" value={fromCents(total.tax)} />
          {tip && <Row label="Propina legal" value={fromCents(total.propina)} />}
          <Row label="Total a cobrar" value={fromCents(total.total)} strong />
        </dl>
      )}

      <div className="space-y-2">
        <p className="text-sm font-medium">Pagos</p>
        {payments.map((p) => (
          <div key={p.key} className="flex items-center gap-2">
            <Select
              aria-label="Forma de pago"
              className="w-40"
              value={p.method}
              onChange={(e) =>
                setPayments((ps) => ps.map((x) => (x.key === p.key ? { ...x, method: e.target.value } : x)))
              }
            >
              {PAYMENT_METHODS.filter((m) => m !== "CREDIT").map((m) => (
                <option key={m} value={m}>
                  {PAYMENT_LABELS[m]}
                </option>
              ))}
            </Select>
            <Input
              aria-label="Monto"
              inputMode="decimal"
              value={shown(p)}
              onChange={(e) => {
                setTyped(true);
                setPayments((ps) =>
                  ps.map((x) => (x.key === p.key ? { ...x, amount: e.target.value } : { ...x, amount: shown(x) })),
                );
              }}
            />
            {payments.length > 1 && (
              <button
                type="button"
                aria-label="Quitar pago"
                className="text-zinc-500 hover:text-red-600"
                onClick={() => setPayments((ps) => ps.filter((x) => x.key !== p.key))}
              >
                ✕
              </button>
            )}
          </div>
        ))}
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            setTyped(true);
            setPayments((ps) => [
              ...ps.map((x) => ({ ...x, amount: shown(x) })),
              { key: Math.max(...ps.map((x) => x.key)) + 1, method: "CARD", amount: "" },
            ]);
          }}
        >
          Dividir el pago
        </Button>
        {total && !balanced && paid >= 0n && (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            {paid < total.total ? "Faltan" : "Sobran"} {money(fromCents(paid < total.total ? total.total - paid : paid - total.total))}
          </p>
        )}
      </div>

      {needsRnc && <p className="text-xs text-amber-700 dark:text-amber-400">El crédito fiscal necesita un cliente con RNC.</p>}
      <ErrorNote message={error} />
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          Cancelar
        </Button>
        <Button disabled={saving || !balanced || needsRnc} onClick={submit}>
          {saving ? "Cobrando…" : "Cobrar"}
        </Button>
      </div>
    </div>
  );
}

function CustomerPicker({
  value,
  requireRnc,
  onChange,
}: {
  value: { id: string; label: string } | null;
  requireRnc: boolean;
  onChange: (value: { id: string; label: string } | null) => void;
}) {
  const [q, setQ] = useState("");
  const dq = useDebounced(q.trim(), 250);
  const results = useQuery(
    useCallback(
      async () =>
        dq
          ? (await unwrap(await api.v1.customers.$get({ query: { q: dq, pageSize: "6", active: "true" } }))).data
          : [],
      [dq],
    ),
  );

  if (value) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700">
        <span className="truncate">{value.label}</span>
        <button type="button" className="shrink-0 text-zinc-500 underline" onClick={() => onChange(null)}>
          Cambiar
        </button>
      </div>
    );
  }
  const list = (results.data ?? []).filter((c) => !requireRnc || c.documentType === "RNC");
  return (
    <div className="space-y-1">
      <Input
        type="search"
        autoComplete="off"
        placeholder={requireRnc ? "Buscar cliente con RNC…" : "Consumidor final · escribe para buscar un cliente"}
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {list.length > 0 && (
        <ul className="rounded-md border border-zinc-200 text-sm dark:border-zinc-800">
          {list.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                className="w-full px-3 py-2 text-left hover:bg-zinc-100 dark:hover:bg-zinc-900"
                onClick={() => onChange({ id: c.id, label: c.name })}
              >
                {c.name}
                {c.documentNumber && <span className="text-xs text-zinc-500"> · {c.documentNumber}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
