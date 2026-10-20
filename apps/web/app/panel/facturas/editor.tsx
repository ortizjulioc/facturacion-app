"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, type FormEvent } from "react";
import {
  calculateDocument,
  DOCUMENT_TYPES,
  ECF_LABELS,
  ECF_TYPES,
  fromCents,
  isModifier,
  MODIFICATION_CODES,
  TAX_CODES,
  TAX_LABELS,
  toCents,
  toMilli,
  type DocumentType,
  type EcfType,
  type LineInput,
  type TaxCode,
} from "@facturacion/core";
import {
  Button,
  Checkbox,
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
import { money, PAYMENT_LABELS, PAYMENT_METHODS } from "@/lib/format";
import { useDebounced, useQuery } from "@/lib/use-query";

// ───────────── Datos de apoyo ─────────────

async function loadInit(docId?: string, referencedId?: string) {
  const [branches, terminals, doc] = await Promise.all([
    unwrap(await api.v1.branches.$get()),
    unwrap(await api.v1.terminals.$get({ query: {} })),
    docId ? unwrap(await api.v1.documents[":id"].$get({ param: { id: docId } })) : null,
  ]);
  const refId = doc?.data.referencedDocumentId ?? referencedId;
  const referenced = refId
    ? await unwrap(await api.v1.documents[":id"].$get({ param: { id: refId } }))
    : null;
  return {
    branches: branches.data.filter((b) => b.active),
    terminals: terminals.data.filter((t) => t.active),
    doc: doc?.data ?? null,
    referenced: referenced?.data ?? null,
  };
}
type Init = Awaited<ReturnType<typeof loadInit>>;
type Doc = NonNullable<Init["doc"]>;

type EditorLine = {
  key: string;
  productId: string | null;
  name: string;
  unit: string;
  quantity: string;
  unitPrice: string;
  tax: TaxCode;
  priceIncludesTax: boolean;
  discountKind: "percent" | "amount";
  discountValue: string;
  /** Línea libre (sin producto): el nombre es editable. */
  manual: boolean;
};

type EditorPayment = { key: string; method: string; amount: string; reference: string };

let counter = 0;
const nextKey = () => `k${++counter}`;
const num = (v: string) => v.trim().replace(",", ".");

const emptyManual = (): EditorLine => ({
  key: nextKey(),
  productId: null,
  name: "",
  unit: "UND",
  quantity: "1",
  unitPrice: "",
  tax: "ITBIS18",
  priceIncludesTax: true,
  discountKind: "percent",
  discountValue: "",
  manual: true,
});

function linesFromDoc(doc: Doc): EditorLine[] {
  return doc.lines.map((l) => ({
    key: nextKey(),
    productId: l.productId,
    name: l.name,
    unit: l.unit,
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    tax: l.tax as TaxCode,
    priceIncludesTax: l.priceIncludesTax,
    discountKind: l.discountInput?.type === "amount" ? "amount" : "percent",
    discountValue: !l.discountInput
      ? ""
      : l.discountInput.type === "percent"
        ? String(l.discountInput.bps / 100)
        : l.discountInput.amount,
    manual: !l.productId,
  }));
}

/** Convierte una línea del editor al formato del motor fiscal; null si aún está incompleta. */
function toCoreLine(l: EditorLine): LineInput | null {
  try {
    const unitPrice = toCents(num(l.unitPrice));
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

// ───────────── Componente principal ─────────────

export function InvoiceEditor({
  docId,
  initialType,
  referencedId,
}: {
  docId?: string;
  initialType?: EcfType;
  referencedId?: string;
}) {
  const init = useQuery(
    useMemo(() => () => loadInit(docId, referencedId), [docId, referencedId]),
  );
  // Next conserva ocultas las pantallas anteriores (con su estado). Cambiar esta clave reinicia el
  // formulario: al guardar con éxito y cuando cambian el comprobante o la referencia que se abre.
  const [session, setSession] = useState(0);

  if (init.error) return <ErrorNote message={init.error} />;
  if (!init.data) return <p className="text-sm text-zinc-500">Cargando…</p>;
  if (init.data.doc && init.data.doc.status !== "DRAFT") {
    return <ErrorNote message="Este comprobante ya fue emitido y no se puede editar." />;
  }
  const formKey = [
    session,
    init.data.doc?.id,
    init.data.referenced?.id,
    initialType,
  ].join(":");
  return (
    <EditorForm
      key={formKey}
      init={init.data}
      initialType={initialType}
      onSaved={() => setSession((n) => n + 1)}
    />
  );
}

function EditorForm({
  init,
  initialType,
  onSaved,
}: {
  init: Init;
  initialType?: EcfType;
  onSaved: () => void;
}) {
  const router = useRouter();
  const { confirm, toast } = useDialogs();
  const { doc, referenced } = init;

  const [type, setType] = useState<EcfType>(
    (doc?.type as EcfType) ?? initialType ?? "E32",
  );
  const [branchId, setBranchId] = useState(doc?.branchId ?? init.branches[0]?.id ?? "");
  const [terminalId, setTerminalId] = useState(doc?.terminalId ?? "");
  const [customerId, setCustomerId] = useState(doc?.customerId ?? "");
  const [customerLabel, setCustomerLabel] = useState(
    doc?.customerId ? (doc.buyerName ?? "") : "",
  );
  const [buyerName, setBuyerName] = useState(
    doc && !doc.customerId ? (doc.buyerName ?? "") : "",
  );
  const [buyerDocType, setBuyerDocType] = useState<string>(
    doc && !doc.customerId ? (doc.buyerDocType ?? "") : "",
  );
  const [buyerDocNumber, setBuyerDocNumber] = useState(
    doc && !doc.customerId ? (doc.buyerDocNumber ?? "") : "",
  );
  const [currency, setCurrency] = useState(doc?.currency ?? "DOP");
  const [rate, setRate] = useState(doc && doc.currency === "USD" ? doc.exchangeRate : "");
  const [propina, setPropina] = useState(doc?.propinaLegal ?? false);
  const [notes, setNotes] = useState(doc?.notes ?? "");
  const [code, setCode] = useState(String(doc?.modificationCode ?? 3));
  const [lines, setLines] = useState<EditorLine[]>(doc ? linesFromDoc(doc) : []);
  const [payments, setPayments] = useState<EditorPayment[]>(
    doc?.payments.map((p) => ({
      key: nextKey(),
      method: p.method,
      amount: p.amount,
      reference: p.reference ?? "",
    })) ?? [],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Si guardar funciona pero emitir falla, el borrador ya existe: el siguiente intento lo actualiza.
  const [draftId, setDraftId] = useState<string | undefined>(doc?.id);

  const modifier = isModifier(type);
  const effectiveCurrency = referenced?.currency ?? currency;

  // Totales en vivo con el mismo motor que usa el servidor.
  const preview = useMemo(() => {
    const coreLines = lines.map(toCoreLine);
    if (coreLines.length === 0 || coreLines.some((l) => l === null)) return null;
    try {
      return calculateDocument({
        lines: coreLines as LineInput[],
        propinaLegal: propina,
      });
    } catch {
      return null;
    }
  }, [lines, propina]);

  const paid = payments.reduce((sum, p) => {
    try {
      return sum + toCents(num(p.amount || "0"));
    } catch {
      return sum;
    }
  }, 0n);
  const total = preview?.total ?? 0n;

  const updateLine = (key: string, patch: Partial<EditorLine>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const updatePayment = (key: string, patch: Partial<EditorPayment>) =>
    setPayments((ps) => ps.map((p) => (p.key === key ? { ...p, ...patch } : p)));

  function buildPayload() {
    return {
      type,
      branchId,
      terminalId: terminalId || null,
      customerId: !modifier && customerId ? customerId : null,
      buyer:
        !modifier && !customerId && (buyerName.trim() || buyerDocNumber.trim())
          ? {
              name: buyerName.trim() || null,
              docType: (buyerDocType || null) as DocumentType | null,
              docNumber: buyerDocNumber.trim() || null,
            }
          : null,
      currency: effectiveCurrency as "DOP" | "USD",
      exchangeRate: effectiveCurrency === "USD" ? num(rate) : "1",
      propinaLegal: propina,
      notes: notes.trim(),
      referencedDocumentId: modifier ? (referenced?.id ?? null) : null,
      modificationCode: modifier ? Number(code) : null,
      lines: lines.map((l) => ({
        productId: l.productId,
        name: l.name.trim() || undefined,
        unitPrice: num(l.unitPrice),
        tax: l.tax,
        priceIncludesTax: l.priceIncludesTax,
        quantity: num(l.quantity),
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
      payments: modifier
        ? []
        : payments
            .filter((p) => num(p.amount))
            .map((p) => ({
              method: p.method as
                "CASH" | "TRANSFER" | "CHECK" | "CARD" | "CREDIT" | "OTHER",
              amount: num(p.amount),
              reference: p.reference.trim(),
            })),
    };
  }

  async function save(thenIssue: boolean) {
    setError(null);
    setBusy(true);
    try {
      const json = buildPayload();
      const saved = draftId
        ? await unwrap(
            await api.v1.documents[":id"].$put({ param: { id: draftId }, json }),
          )
        : await unwrap(await api.v1.documents.$post({ json }));
      const id = saved.data.id;
      setDraftId(id);
      const issued = thenIssue
        ? await unwrap(await api.v1.documents[":id"].issue.$post({ param: { id } }))
        : null;
      toast(issued ? `Comprobante emitido: ${issued.data.encf}` : "Borrador guardado");
      onSaved();
      router.push(`/panel/facturas/${id}`);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void save(false);
  }

  const title = doc ? "Editar borrador" : `Nueva ${ECF_LABELS[type].toLowerCase()}`;

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      <PageHeader
        title={title}
        description={
          modifier && referenced
            ? `Modifica el comprobante ${referenced.encf}`
            : undefined
        }
        actions={
          <Link href="/panel/facturas" className="text-sm underline">
            Cancelar
          </Link>
        }
      />

      {/* Encabezado */}
      <section className="grid gap-4 rounded-lg border border-zinc-200 p-4 md:grid-cols-4 dark:border-zinc-800">
        <Field label="Tipo de comprobante" className="md:col-span-2">
          <Select
            value={type}
            disabled={Boolean(doc) || Boolean(referenced)}
            onChange={(e) => setType(e.target.value as EcfType)}
          >
            {ECF_TYPES.filter((t) => !isModifier(t) || referenced || doc).map((t) => (
              <option key={t} value={t}>
                {t} · {ECF_LABELS[t]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Sucursal">
          <Select
            value={branchId}
            onChange={(e) => {
              setBranchId(e.target.value);
              setTerminalId("");
            }}
          >
            {init.branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Caja">
          <Select value={terminalId} onChange={(e) => setTerminalId(e.target.value)}>
            <option value="">Sin caja</option>
            {init.terminals
              .filter((t) => t.branchId === branchId)
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
          </Select>
        </Field>

        {modifier ? (
          <>
            <Field label="Motivo de la modificación" className="md:col-span-2">
              <Select value={code} onChange={(e) => setCode(e.target.value)}>
                {Object.entries(MODIFICATION_CODES).map(([k, label]) => (
                  <option key={k} value={k}>
                    {k} · {label}
                  </option>
                ))}
              </Select>
            </Field>
            {referenced && (
              <p className="text-sm text-zinc-600 md:col-span-2 dark:text-zinc-400">
                Comprador: <strong>{referenced.buyerName ?? "Consumidor final"}</strong> ·
                Original: {money(referenced.total, referenced.currency)}
              </p>
            )}
          </>
        ) : (
          <>
            <Field label="Cliente" className="md:col-span-2">
              <CustomerPicker
                value={customerId}
                label={customerLabel}
                requireRnc={type === "E31"}
                onChange={(id, label) => {
                  setCustomerId(id);
                  setCustomerLabel(label);
                }}
              />
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
            {!customerId && type === "E32" && (
              <div className="grid gap-4 md:col-span-4 md:grid-cols-3">
                <Field label="Nombre del comprador (opcional)">
                  <Input
                    value={buyerName}
                    onChange={(e) => setBuyerName(e.target.value)}
                  />
                </Field>
                <Field label="Documento (obligatorio desde RD$250,000)">
                  <Select
                    value={buyerDocType}
                    onChange={(e) => setBuyerDocType(e.target.value)}
                  >
                    <option value="">Sin identificar</option>
                    {DOCUMENT_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Número">
                  <Input
                    value={buyerDocNumber}
                    disabled={!buyerDocType}
                    onChange={(e) => setBuyerDocNumber(e.target.value)}
                  />
                </Field>
              </div>
            )}
          </>
        )}
      </section>

      {/* Líneas */}
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
        {!modifier && (
          <ProductPicker
            onPick={(p) =>
              setLines((ls) => [
                ...ls,
                {
                  key: nextKey(),
                  productId: p.id,
                  name: p.name,
                  unit: p.unit,
                  quantity: "1",
                  unitPrice: p.price,
                  tax: p.tax as TaxCode,
                  priceIncludesTax: p.priceIncludesTax,
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
                <th className={`${tableStyles.th} w-32`}>Precio</th>
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
                        Precio con impuesto incluido
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
                        aria-label="Precio"
                        value={l.unitPrice}
                        inputMode="decimal"
                        placeholder="0.00"
                        onChange={(e) => updateLine(l.key, { unitPrice: e.target.value })}
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
                        ? money(fromCents(lineTotal), effectiveCurrency)
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
              {modifier
                ? "Agrega una línea libre con el monto a acreditar o debitar."
                : "Busca un producto o escanea su código de barras para empezar."}
            </p>
          )}
        </div>
      </section>

      <div className="grid gap-6 md:grid-cols-2">
        {/* Pagos y notas */}
        <section className="space-y-4">
          {!modifier && (
            <div className="space-y-3">
              <h2 className="text-lg font-medium">Pagos</h2>
              {payments.map((p) => (
                <div key={p.key} className="flex items-center gap-2">
                  <Select
                    aria-label="Forma de pago"
                    className="w-40"
                    value={p.method}
                    onChange={(e) => updatePayment(p.key, { method: e.target.value })}
                  >
                    {PAYMENT_METHODS.map((m) => (
                      <option key={m} value={m}>
                        {PAYMENT_LABELS[m]}
                      </option>
                    ))}
                  </Select>
                  <Input
                    aria-label="Monto"
                    value={p.amount}
                    inputMode="decimal"
                    placeholder="0.00"
                    onChange={(e) => updatePayment(p.key, { amount: e.target.value })}
                  />
                  <button
                    type="button"
                    aria-label="Quitar pago"
                    className="text-zinc-500 hover:text-red-600"
                    onClick={() => setPayments((ps) => ps.filter((x) => x.key !== p.key))}
                  >
                    ✕
                  </button>
                </div>
              ))}
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  disabled={!preview}
                  onClick={() =>
                    setPayments([
                      {
                        key: nextKey(),
                        method: "CASH",
                        amount: fromCents(total),
                        reference: "",
                      },
                    ])
                  }
                >
                  Pagar el total en efectivo
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() =>
                    setPayments((ps) => [
                      ...ps,
                      { key: nextKey(), method: "CARD", amount: "", reference: "" },
                    ])
                  }
                >
                  Agregar pago
                </Button>
              </div>
              <p className="text-sm tabular-nums text-zinc-600 dark:text-zinc-400">
                Pagado {money(fromCents(paid), effectiveCurrency)}
                {preview && paid !== total && (
                  <span className="ml-2 text-amber-700 dark:text-amber-400">
                    {paid < total ? "faltan" : "sobran"}{" "}
                    {money(
                      fromCents(paid < total ? total - paid : paid - total),
                      effectiveCurrency,
                    )}
                  </span>
                )}
              </p>
            </div>
          )}
          <Field label="Notas internas">
            <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </section>

        {/* Totales */}
        <section className="space-y-2 rounded-lg border border-zinc-200 p-4 text-sm tabular-nums dark:border-zinc-800">
          <Row label="Subtotal" value={preview?.subtotal} currency={effectiveCurrency} />
          {preview && preview.totalDiscount > 0n && (
            <Row
              label="Descuentos"
              value={preview.totalDiscount}
              currency={effectiveCurrency}
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
                currency={effectiveCurrency}
              />
            ))}
          {!modifier && (
            <div className="py-1">
              <Checkbox
                label="Agregar propina legal (10 %)"
                checked={propina}
                onChange={(e) => setPropina(e.target.checked)}
              />
            </div>
          )}
          {preview && preview.propinaLegal > 0n && (
            <Row
              label="Propina legal"
              value={preview.propinaLegal}
              currency={effectiveCurrency}
            />
          )}
          <div className="flex items-baseline justify-between border-t border-zinc-200 pt-3 text-lg font-semibold dark:border-zinc-800">
            <span>Total</span>
            <span>
              {preview ? money(fromCents(preview.total), effectiveCurrency) : "—"}
            </span>
          </div>
          {!preview && lines.length > 0 && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              Completa precio y cantidad de todas las líneas.
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
                  await api.v1.documents[":id"].$delete({ param: { id: draftId } }),
                );
                onSaved();
                router.push("/panel/facturas");
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
          Guardar y emitir
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
      <span>{value === undefined ? "—" : money(fromCents(value), currency)}</span>
    </div>
  );
}

// ───────────── Buscador de productos / lector de códigos ─────────────

export type PickedProduct = {
  id: string;
  name: string;
  unit: string;
  price: string;
  tax: string;
  priceIncludesTax: boolean;
};

export function ProductPicker({ onPick }: { onPick: (p: PickedProduct) => void }) {
  const [q, setQ] = useState("");
  const dq = useDebounced(q.trim(), 250);
  const [scanError, setScanError] = useState<string | null>(null);

  const results = useQuery(
    useMemo(
      () => async () =>
        dq
          ? (
              await unwrap(
                await api.v1.products.$get({
                  query: { q: dq, pageSize: "8", active: "true" },
                }),
              )
            ).data
          : [],
      [dq],
    ),
  );

  function pick(p: PickedProduct) {
    onPick(p);
    setQ("");
    setScanError(null);
  }

  // Los lectores de código de barras "teclean" el código y envían Enter: buscamos coincidencia exacta.
  async function onEnter() {
    const code = q.trim();
    if (!code) return;
    setScanError(null);
    const res = await api.v1.products["by-barcode"][":code"].$get({ param: { code } });
    if (res.ok) {
      pick((await res.json()).data);
      return;
    }
    const first = results.data?.[0];
    if (first && dq === code) pick(first);
    else setScanError(`No se encontró el producto "${code}"`);
  }

  const list = results.data ?? [];
  return (
    <div className="relative">
      <Input
        type="search"
        autoComplete="off"
        placeholder="Buscar producto por nombre, SKU o escanear código de barras…"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setScanError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void onEnter();
          }
        }}
      />
      {scanError && <p className="mt-1 text-sm text-red-600">{scanError}</p>}
      {q.trim() && list.length > 0 && (
        <ul className="absolute z-10 mt-1 w-full overflow-hidden rounded-md border border-zinc-200 bg-background shadow-lg dark:border-zinc-800">
          {list.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                className="flex w-full items-center justify-between gap-4 px-3 py-2 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-900"
                onClick={() => pick(p)}
              >
                <span>
                  {p.name}
                  <span className="ml-2 font-mono text-xs text-zinc-500">
                    {p.barcode ?? p.sku ?? ""}
                  </span>
                </span>
                <span className="tabular-nums text-zinc-600 dark:text-zinc-400">
                  {money(p.price)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ───────────── Buscador de clientes ─────────────

function CustomerPicker({
  value,
  label,
  requireRnc,
  onChange,
}: {
  value: string;
  label: string;
  /** Factura de crédito fiscal: solo sirven clientes con RNC. */
  requireRnc: boolean;
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
                await api.v1.customers.$get({
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

  const list = (results.data ?? []).filter(
    (c) => !requireRnc || c.documentType === "RNC",
  );
  return (
    <div className="relative">
      <Input
        type="search"
        autoComplete="off"
        placeholder={
          requireRnc
            ? "Buscar cliente con RNC…"
            : "Consumidor final · escribe para buscar un cliente"
        }
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {q.trim() && (
        <ul className="absolute z-10 mt-1 w-full overflow-hidden rounded-md border border-zinc-200 bg-background text-sm font-normal shadow-lg dark:border-zinc-800">
          {list.map((c) => {
            const doc =
              c.documentType && c.documentNumber
                ? `${c.documentType} ${c.documentNumber}`
                : "";
            return (
              <li key={c.id}>
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-4 px-3 py-2 text-left hover:bg-zinc-100 dark:hover:bg-zinc-900"
                  onClick={() => {
                    onChange(c.id, doc ? `${c.name} · ${doc}` : c.name);
                    setQ("");
                  }}
                >
                  <span>{c.name}</span>
                  <span className="font-mono text-xs text-zinc-500">{doc}</span>
                </button>
              </li>
            );
          })}
          {list.length === 0 && !results.loading && (
            <li className="px-3 py-2 text-zinc-500">
              {requireRnc
                ? "Ningún cliente con RNC coincide."
                : "Ningún cliente coincide."}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
