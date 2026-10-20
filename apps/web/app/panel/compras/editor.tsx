"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, type FormEvent } from "react";
import {
  calculateDocument,
  EXPENSE_TYPES,
  formatDocument,
  fromCents,
  TAX_CODES,
  TAX_LABELS,
  toCents,
  toMilli,
  type DocumentType,
  type LineInput,
  type TaxCode,
} from "@facturacion/core";
import {
  Button,
  ErrorNote,
  Field,
  Input,
  PageHeader,
  Select,
  Textarea,
  tableStyles,
} from "@/components/ui";
import { useDialogs } from "@/components/dialogs";
import { api, errorMessage, expectOk, unwrap } from "@/lib/api";
import { money, PAYMENT_LABELS, PAYMENT_METHODS, todayLocal } from "@/lib/format";
import { useDebounced, useQuery } from "@/lib/use-query";
import { ProductPicker } from "../facturas/editor";

type Kind = "SUPPLIER_INVOICE" | "E41" | "E43";

const KIND_OPTIONS: { value: Kind; label: string; hint: string }[] = [
  {
    value: "SUPPLIER_INVOICE",
    label: "Factura de proveedor",
    hint: "El proveedor ya te entregó su factura (con NCF). Aquí la registras.",
  },
  {
    value: "E41",
    label: "Comprobante de compras (E41)",
    hint: "Compras a proveedores informales que no emiten comprobante: lo emites tú y el sistema le asigna el e-NCF.",
  },
  {
    value: "E43",
    label: "Gasto menor (E43)",
    hint: "Gastos pequeños sin comprobante (taxi, parqueo…): lo emites tú y el sistema le asigna el e-NCF.",
  },
];

async function loadInit(purchaseId?: string) {
  const [branches, purchase] = await Promise.all([
    unwrap(await api.v1.branches.$get()),
    purchaseId
      ? unwrap(await api.v1.purchases[":id"].$get({ param: { id: purchaseId } }))
      : null,
  ]);
  return {
    branches: branches.data.filter((b) => b.active),
    purchase: purchase?.data ?? null,
  };
}
type Init = Awaited<ReturnType<typeof loadInit>>;

type PLine = {
  key: string;
  productId: string | null;
  name: string;
  quantity: string;
  unitCost: string;
  tax: TaxCode;
  priceIncludesTax: boolean;
  discountKind: "percent" | "amount";
  discountValue: string;
  manual: boolean;
};

let counter = 0;
const nextKey = () => `p${++counter}`;
const num = (v: string) => v.trim().replace(",", ".");

const emptyManual = (): PLine => ({
  key: nextKey(),
  productId: null,
  name: "",
  quantity: "1",
  unitCost: "",
  tax: "ITBIS18",
  priceIncludesTax: false,
  discountKind: "percent",
  discountValue: "",
  manual: true,
});

function toCoreLine(l: PLine): LineInput | null {
  try {
    const unitPrice = toCents(num(l.unitCost));
    const quantity = toMilli(num(l.quantity));
    if (quantity <= 0n) return null;
    const dv = num(l.discountValue);
    const discount: LineInput["discount"] = !dv
      ? undefined
      : l.discountKind === "percent"
        ? { type: "percent", bps: Math.round(Number(dv) * 100) }
        : { type: "amount", cents: toCents(dv) };
    return {
      unitPrice,
      quantity,
      tax: l.tax,
      priceIncludesTax: l.priceIncludesTax,
      ...(discount ? { discount } : {}),
    };
  } catch {
    return null;
  }
}

export function PurchaseEditor({ purchaseId }: { purchaseId?: string }) {
  const init = useQuery(useMemo(() => () => loadInit(purchaseId), [purchaseId]));
  // Next conserva ocultas las pantallas anteriores (con su estado): esta clave reinicia el formulario
  // al guardar con éxito y al abrir otra compra.
  const [session, setSession] = useState(0);

  if (init.error) return <ErrorNote message={init.error} />;
  if (!init.data) return <p className="text-sm text-zinc-500">Cargando…</p>;
  if (init.data.purchase && init.data.purchase.status !== "DRAFT") {
    return <ErrorNote message="Esta compra ya está registrada y no se puede editar." />;
  }
  return (
    <EditorForm
      key={`${session}:${init.data.purchase?.id ?? ""}`}
      init={init.data}
      onSaved={() => setSession((n) => n + 1)}
    />
  );
}

function EditorForm({ init, onSaved }: { init: Init; onSaved: () => void }) {
  const router = useRouter();
  const { confirm, toast } = useDialogs();
  const { purchase } = init;

  const [kind, setKind] = useState<Kind>((purchase?.kind as Kind) ?? "SUPPLIER_INVOICE");
  const [branchId, setBranchId] = useState(
    purchase?.branchId ?? init.branches[0]?.id ?? "",
  );
  const [supplierId, setSupplierId] = useState(purchase?.supplierId ?? "");
  const [supplierLabel, setSupplierLabel] = useState(purchase?.supplierName ?? "");
  const [ncf, setNcf] = useState(
    purchase?.kind === "SUPPLIER_INVOICE" ? (purchase.ncf ?? "") : "",
  );
  const [invoiceDate, setInvoiceDate] = useState(purchase?.invoiceDate ?? todayLocal());
  const [expenseType, setExpenseType] = useState(String(purchase?.expenseType ?? 9));
  const [paymentMethod, setPaymentMethod] = useState<string>(
    purchase?.paymentMethod ?? "CASH",
  );
  const [currency, setCurrency] = useState(purchase?.currency ?? "DOP");
  const [rate, setRate] = useState(
    purchase && purchase.currency === "USD" ? purchase.exchangeRate : "",
  );
  const [notes, setNotes] = useState(purchase?.notes ?? "");
  const [itbisWithheld, setItbisWithheld] = useState(
    purchase && Number(purchase.totals.itbisWithheld) > 0
      ? purchase.totals.itbisWithheld
      : "",
  );
  const [isrWithheld, setIsrWithheld] = useState(
    purchase && Number(purchase.totals.isrWithheld) > 0
      ? purchase.totals.isrWithheld
      : "",
  );
  const [lines, setLines] = useState<PLine[]>(
    purchase?.lines.map((l) => ({
      key: nextKey(),
      productId: l.productId,
      name: l.name,
      quantity: l.quantity,
      unitCost: l.unitCost,
      tax: l.tax as TaxCode,
      priceIncludesTax: l.priceIncludesTax,
      discountKind: l.discountInput?.type === "amount" ? "amount" : "percent",
      discountValue: !l.discountInput
        ? ""
        : l.discountInput.type === "percent"
          ? String(l.discountInput.bps / 100)
          : l.discountInput.amount,
      manual: !l.productId,
    })) ?? [],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Si guardar funciona pero registrar falla, el borrador ya existe: el siguiente intento lo actualiza.
  const [draftId, setDraftId] = useState<string | undefined>(purchase?.id);

  const kindInfo = KIND_OPTIONS.find((k) => k.value === kind)!;
  const isExpense = kind === "E43";

  const preview = useMemo(() => {
    const coreLines = lines.map(toCoreLine);
    if (coreLines.length === 0 || coreLines.some((l) => l === null)) return null;
    try {
      return calculateDocument({ lines: coreLines as LineInput[] });
    } catch {
      return null;
    }
  }, [lines]);

  const cents = (v: string) => {
    try {
      return toCents(num(v || "0"));
    } catch {
      return 0n;
    }
  };
  const withheld = isExpense ? 0n : cents(itbisWithheld) + cents(isrWithheld);
  const net = preview ? preview.total - withheld : 0n;

  const updateLine = (key: string, patch: Partial<PLine>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  function buildPayload() {
    return {
      kind,
      branchId,
      supplierId: supplierId || null,
      ncf: kind === "SUPPLIER_INVOICE" ? ncf.trim() : null,
      invoiceDate,
      currency: currency as "DOP" | "USD",
      exchangeRate: currency === "USD" ? num(rate) : "1",
      expenseType: Number(expenseType),
      paymentMethod: paymentMethod as
        "CASH" | "TRANSFER" | "CHECK" | "CARD" | "CREDIT" | "OTHER",
      notes: notes.trim(),
      itbisWithheld: isExpense ? "0" : num(itbisWithheld) || "0",
      isrWithheld: isExpense ? "0" : num(isrWithheld) || "0",
      lines: lines.map((l) => ({
        productId: l.productId,
        name: l.name.trim() || undefined,
        quantity: num(l.quantity),
        unitCost: num(l.unitCost),
        tax: l.tax,
        priceIncludesTax: l.priceIncludesTax,
        ...(num(l.discountValue)
          ? {
              discount:
                l.discountKind === "percent"
                  ? ({
                      type: "percent",
                      bps: Math.round(Number(num(l.discountValue)) * 100),
                    } as const)
                  : ({ type: "amount", amount: num(l.discountValue) } as const),
            }
          : {}),
      })),
    };
  }

  async function save(thenPost: boolean) {
    setError(null);
    setBusy(true);
    try {
      const json = buildPayload();
      const saved = draftId
        ? await unwrap(
            await api.v1.purchases[":id"].$put({ param: { id: draftId }, json }),
          )
        : await unwrap(await api.v1.purchases.$post({ json }));
      const id = saved.data.id;
      setDraftId(id);
      const posted = thenPost
        ? await unwrap(await api.v1.purchases[":id"].post.$post({ param: { id } }))
        : null;
      toast(posted ? `Compra registrada: ${posted.data.ncf}` : "Borrador guardado");
      onSaved();
      router.push(`/panel/compras/${id}`);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void save(false);
  }

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      <PageHeader
        title={purchase ? "Editar compra" : "Nueva compra"}
        actions={
          <Link href="/panel/compras" className="text-sm underline">
            Cancelar
          </Link>
        }
      />

      <section className="grid gap-4 rounded-lg border border-zinc-200 p-4 md:grid-cols-4 dark:border-zinc-800">
        <Field label="Tipo de compra" className="md:col-span-2" hint={kindInfo.hint}>
          <Select
            value={kind}
            disabled={Boolean(purchase)}
            onChange={(e) => {
              const next = e.target.value as Kind;
              setKind(next);
              // Los gastos menores no llevan productos de inventario ni retenciones.
              if (next === "E43") setLines((ls) => ls.filter((l) => !l.productId));
              setExpenseType(
                next === "E43" ? "2" : next === "SUPPLIER_INVOICE" ? "9" : "2",
              );
            }}
          >
            {KIND_OPTIONS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Sucursal (entra el inventario aquí)">
          <Select value={branchId} onChange={(e) => setBranchId(e.target.value)}>
            {init.branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Fecha del comprobante">
          <Input
            type="date"
            value={invoiceDate}
            onChange={(e) => setInvoiceDate(e.target.value)}
            required
          />
        </Field>

        <Field
          label={isExpense ? "Proveedor (opcional)" : "Proveedor"}
          className="md:col-span-2"
        >
          <SupplierPicker
            value={supplierId}
            label={supplierLabel}
            onChange={(id, label) => {
              setSupplierId(id);
              setSupplierLabel(label);
            }}
          />
        </Field>
        {kind === "SUPPLIER_INVOICE" && (
          <Field label="NCF de la factura" hint="Ej: B0100000123 o E310000000045">
            <Input
              value={ncf}
              onChange={(e) => setNcf(e.target.value)}
              placeholder="B0100000123"
              required
            />
          </Field>
        )}
        <Field
          label="Tipo de gasto (606)"
          className={kind === "SUPPLIER_INVOICE" ? "" : "md:col-span-2"}
        >
          <Select value={expenseType} onChange={(e) => setExpenseType(e.target.value)}>
            {Object.entries(EXPENSE_TYPES).map(([k, label]) => (
              <option key={k} value={k}>
                {k.padStart(2, "0")} · {label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Forma de pago">
          <Select
            value={paymentMethod}
            onChange={(e) => setPaymentMethod(e.target.value)}
          >
            {PAYMENT_METHODS.map((m) => (
              <option key={m} value={m}>
                {PAYMENT_LABELS[m]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Moneda">
          <Select value={currency} onChange={(e) => setCurrency(e.target.value)}>
            <option value="DOP">Pesos (RD$)</option>
            <option value="USD">Dólares (US$)</option>
          </Select>
        </Field>
        {currency === "USD" && (
          <Field label="Tasa de cambio">
            <Input
              value={rate}
              inputMode="decimal"
              placeholder="58.50"
              onChange={(e) => setRate(e.target.value)}
            />
          </Field>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 className="text-lg font-medium">Detalle</h2>
          <Button
            type="button"
            variant="secondary"
            onClick={() => setLines((ls) => [...ls, emptyManual()])}
          >
            Agregar línea libre
          </Button>
        </div>
        {!isExpense && (
          <ProductPicker
            onPick={(p) =>
              setLines((ls) => [
                ...ls,
                {
                  key: nextKey(),
                  productId: p.id,
                  name: p.name,
                  quantity: "1",
                  unitCost: "",
                  tax: p.tax as TaxCode,
                  priceIncludesTax: false,
                  discountKind: "percent",
                  discountValue: "",
                  manual: false,
                },
              ])
            }
          />
        )}

        <div className={tableStyles.wrapper}>
          <table className={tableStyles.table}>
            <thead>
              <tr>
                <th className={tableStyles.th}>Descripción</th>
                <th className={`${tableStyles.th} w-24`}>Cant.</th>
                <th className={`${tableStyles.th} w-32`}>Costo unitario</th>
                <th className={`${tableStyles.th} w-40`}>Impuesto</th>
                <th className={`${tableStyles.th} w-32`}>Descuento</th>
                <th className={`${tableStyles.th} w-32 text-right`}>Total</th>
                <th className={`${tableStyles.th} w-10`} />
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => {
                const lineTotal = preview?.lines[i]?.total;
                return (
                  <tr key={l.key}>
                    <td className={tableStyles.td}>
                      {l.manual ? (
                        <Input
                          aria-label="Descripción"
                          value={l.name}
                          placeholder="Descripción"
                          onChange={(e) => updateLine(l.key, { name: e.target.value })}
                        />
                      ) : (
                        <span className="font-medium">{l.name}</span>
                      )}
                      <label className="mt-1 flex items-center gap-1.5 text-xs text-zinc-500">
                        <input
                          type="checkbox"
                          checked={l.priceIncludesTax}
                          onChange={(e) =>
                            updateLine(l.key, { priceIncludesTax: e.target.checked })
                          }
                        />
                        El costo ya incluye el impuesto
                      </label>
                    </td>
                    <td className={tableStyles.td}>
                      <Input
                        aria-label="Cantidad"
                        value={l.quantity}
                        inputMode="decimal"
                        onChange={(e) => updateLine(l.key, { quantity: e.target.value })}
                      />
                    </td>
                    <td className={tableStyles.td}>
                      <Input
                        aria-label="Costo unitario"
                        value={l.unitCost}
                        inputMode="decimal"
                        placeholder="0.00"
                        onChange={(e) => updateLine(l.key, { unitCost: e.target.value })}
                      />
                    </td>
                    <td className={tableStyles.td}>
                      <Select
                        aria-label="Impuesto"
                        value={l.tax}
                        onChange={(e) =>
                          updateLine(l.key, { tax: e.target.value as TaxCode })
                        }
                      >
                        {TAX_CODES.map((t) => (
                          <option key={t} value={t}>
                            {TAX_LABELS[t]}
                          </option>
                        ))}
                      </Select>
                    </td>
                    <td className={tableStyles.td}>
                      <div className="flex gap-1">
                        <Input
                          aria-label="Descuento"
                          value={l.discountValue}
                          inputMode="decimal"
                          placeholder="0"
                          onChange={(e) =>
                            updateLine(l.key, { discountValue: e.target.value })
                          }
                        />
                        <Select
                          aria-label="Tipo de descuento"
                          className="w-16 px-1"
                          value={l.discountKind}
                          onChange={(e) =>
                            updateLine(l.key, {
                              discountKind: e.target.value as "percent" | "amount",
                            })
                          }
                        >
                          <option value="percent">%</option>
                          <option value="amount">$</option>
                        </Select>
                      </div>
                    </td>
                    <td className={`${tableStyles.td} text-right tabular-nums`}>
                      {lineTotal !== undefined
                        ? money(fromCents(lineTotal), currency)
                        : "—"}
                    </td>
                    <td className={tableStyles.td}>
                      <button
                        type="button"
                        aria-label="Quitar línea"
                        className="text-zinc-500 hover:text-red-600"
                        onClick={() =>
                          setLines((ls) => ls.filter((x) => x.key !== l.key))
                        }
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {lines.length === 0 && (
            <p className="px-4 py-8 text-center text-sm text-zinc-500">
              {isExpense
                ? "Agrega una línea libre con el detalle del gasto."
                : "Busca un producto o agrega una línea libre para empezar."}
            </p>
          )}
        </div>
      </section>

      <div className="grid gap-6 md:grid-cols-2">
        <section className="space-y-4">
          {!isExpense && (
            <div className="grid grid-cols-2 gap-4">
              <Field label="ITBIS retenido" hint="Opcional">
                <Input
                  value={itbisWithheld}
                  inputMode="decimal"
                  placeholder="0.00"
                  onChange={(e) => setItbisWithheld(e.target.value)}
                />
              </Field>
              <Field label="ISR retenido" hint="Opcional">
                <Input
                  value={isrWithheld}
                  inputMode="decimal"
                  placeholder="0.00"
                  onChange={(e) => setIsrWithheld(e.target.value)}
                />
              </Field>
            </div>
          )}
          <Field label="Notas internas">
            <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </section>

        <section className="space-y-2 rounded-lg border border-zinc-200 p-4 text-sm tabular-nums dark:border-zinc-800">
          <Row label="Subtotal" value={preview?.subtotal} currency={currency} />
          {preview && preview.totalDiscount > 0n && (
            <Row
              label="Descuentos incluidos"
              value={preview.totalDiscount}
              currency={currency}
            />
          )}
          {preview &&
            TAX_CODES.filter(
              (c) => c.startsWith("ITBIS") && preview.byTax[c].taxAmount > 0n,
            ).map((c) => (
              <Row
                key={c}
                label={TAX_LABELS[c]}
                value={preview.byTax[c].taxAmount}
                currency={currency}
              />
            ))}
          <div className="flex items-baseline justify-between border-t border-zinc-200 pt-3 text-lg font-semibold dark:border-zinc-800">
            <span>Total</span>
            <span>{preview ? money(fromCents(preview.total), currency) : "—"}</span>
          </div>
          {preview && withheld > 0n && (
            <>
              <Row label="Retenciones" value={-withheld} currency={currency} />
              <div className="flex justify-between font-medium">
                <span>Neto a pagar</span>
                <span>{money(fromCents(net), currency)}</span>
              </div>
            </>
          )}
          {!preview && lines.length > 0 && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              Completa costo y cantidad de todas las líneas.
            </p>
          )}
        </section>
      </div>

      <ErrorNote message={error} />
      <div className="flex flex-wrap justify-end gap-3">
        {draftId && (
          <Button
            type="button"
            variant="danger"
            disabled={busy}
            onClick={async () => {
              const ok = await confirm({
                title: "Eliminar borrador",
                message: "Esta acción no se puede deshacer.",
                confirmLabel: "Eliminar",
                danger: true,
              });
              if (!ok) return;
              try {
                await expectOk(
                  await api.v1.purchases[":id"].$delete({ param: { id: draftId } }),
                );
                onSaved();
                toast("Borrador eliminado");
                router.push("/panel/compras");
              } catch (e) {
                setError(errorMessage(e));
              }
            }}
          >
            Eliminar borrador
          </Button>
        )}
        <Button
          type="submit"
          variant="secondary"
          disabled={busy || !preview || !branchId}
        >
          {busy ? "Guardando…" : "Guardar borrador"}
        </Button>
        <Button
          type="button"
          disabled={busy || !preview || !branchId}
          onClick={() => void save(true)}
        >
          Guardar y registrar
        </Button>
      </div>
    </form>
  );
}

function Row({
  label,
  value,
  currency,
}: {
  label: string;
  value: bigint | undefined;
  currency: string;
}) {
  return (
    <div className="flex justify-between">
      <span className="text-zinc-600 dark:text-zinc-400">{label}</span>
      <span>
        {value === undefined
          ? "—"
          : value < 0n
            ? `−${money(fromCents(-value), currency)}`
            : money(fromCents(value), currency)}
      </span>
    </div>
  );
}

// ───────────── Buscador de proveedores ─────────────

function SupplierPicker({
  value,
  label,
  onChange,
}: {
  value: string;
  label: string;
  onChange: (id: string, label: string) => void;
}) {
  const [q, setQ] = useState("");
  const dq = useDebounced(q.trim(), 250);

  const results = useQuery(
    useMemo(
      () => async () =>
        dq
          ? (
              await unwrap(
                await api.v1.suppliers.$get({
                  query: { q: dq, pageSize: "8", active: "true" },
                }),
              )
            ).data
          : [],
      [dq],
    ),
  );

  if (value) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-md border border-zinc-300 px-3 py-2 text-sm font-normal dark:border-zinc-700">
        <span className="truncate">{label}</span>
        <button
          type="button"
          className="shrink-0 text-zinc-500 underline hover:text-foreground"
          onClick={() => onChange("", "")}
        >
          Cambiar
        </button>
      </div>
    );
  }

  const list = results.data ?? [];
  return (
    <div className="relative">
      <Input
        type="search"
        autoComplete="off"
        placeholder="Buscar proveedor por nombre o RNC/cédula…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {q.trim() && (
        <ul className="absolute z-10 mt-1 w-full overflow-hidden rounded-md border border-zinc-200 bg-background text-sm font-normal shadow-lg dark:border-zinc-800">
          {list.map((s) => {
            const doc =
              s.documentType && s.documentNumber
                ? `${s.documentType} ${formatDocument(s.documentType as DocumentType, s.documentNumber)}`
                : "";
            return (
              <li key={s.id}>
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-4 px-3 py-2 text-left hover:bg-zinc-100 dark:hover:bg-zinc-900"
                  onClick={() => {
                    onChange(s.id, doc ? `${s.name} · ${doc}` : s.name);
                    setQ("");
                  }}
                >
                  <span>{s.name}</span>
                  <span className="font-mono text-xs text-zinc-500">{doc}</span>
                </button>
              </li>
            );
          })}
          {list.length === 0 && !results.loading && (
            <li className="px-3 py-2 text-zinc-500">
              Ningún proveedor coincide. Créalo primero en la sección Proveedores.
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
