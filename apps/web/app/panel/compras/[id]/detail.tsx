"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import {
  formatDocument,
  ISR_WITHHOLDING_TYPES,
  TAX_LABELS,
  type DocumentType,
  type TaxCode,
} from "@facturacion/core";
import { Badge, Button, ErrorNote, PageHeader, tableStyles } from "@/components/ui";
import { useDialogs } from "@/components/dialogs";
import { usePanel } from "@/components/panel-context";
import { api, errorMessage, expectOk, unwrap } from "@/lib/api";
import { formatDate, formatDateTime, money, PAYMENT_LABELS } from "@/lib/format";
import { useQuery } from "@/lib/use-query";

const linkButton =
  "inline-flex items-center justify-center rounded-md px-3.5 py-2 text-sm font-medium transition border border-zinc-300 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900";

export function PurchaseDetail({ id }: { id: string }) {
  const router = useRouter();
  const { canManage } = usePanel();
  const { confirm, toast } = useDialogs();
  const load = useMemo(
    () => async () =>
      (await unwrap(await api.v1.purchases[":id"].$get({ param: { id } }))).data,
    [id],
  );
  const { data: p, error, reload } = useQuery(load);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  if (!canManage)
    return (
      <ErrorNote message="Solo propietarios y administradores pueden ver las compras." />
    );
  if (error) return <ErrorNote message={error} />;
  if (!p) return <p className="text-sm text-zinc-500">Cargando…</p>;

  const cur = p.currency;
  const draft = p.status === "DRAFT";
  const t = p.totals;
  const withheld = Number(t.itbisWithheld) + Number(t.isrWithheld);

  async function run(action: () => Promise<unknown>) {
    setActionError(null);
    setBusy(true);
    try {
      await action();
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title={p.ncf ?? `Borrador · ${p.kindLabel}`}
        description={`${p.kindLabel} · ${p.expenseLabel}`}
        actions={
          draft ? (
            <>
              <Link href={`/panel/compras/${p.id}/editar`} className={linkButton}>
                Editar
              </Link>
              <Button
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    const posted = await unwrap(
                      await api.v1.purchases[":id"].post.$post({ param: { id: p.id } }),
                    );
                    toast(`Compra registrada: ${posted.data.ncf}`);
                    reload();
                  })
                }
              >
                Registrar
              </Button>
            </>
          ) : (
            <Link href="/panel/inventario" className={linkButton}>
              Ver inventario
            </Link>
          )
        }
      />
      <ErrorNote message={actionError} />

      <article className="space-y-6 rounded-lg border border-zinc-200 p-6 dark:border-zinc-800">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="text-sm">
            <p className="text-xs uppercase tracking-wide text-zinc-500">Proveedor</p>
            <p className="font-medium">{p.supplierName ?? "—"}</p>
            {p.supplierDocType && p.supplierDocNumber && (
              <p className="text-zinc-600 dark:text-zinc-400">
                {p.supplierDocType}{" "}
                {formatDocument(p.supplierDocType as DocumentType, p.supplierDocNumber)}
              </p>
            )}
          </div>
          <div className="text-right text-sm">
            <p className="font-mono">{p.ncf ?? "Sin NCF (se asigna al registrar)"}</p>
            <p className="text-zinc-600 dark:text-zinc-400">
              Comprobante del {formatDate(p.invoiceDate)}
            </p>
            {p.postedAt && (
              <p className="text-zinc-600 dark:text-zinc-400">
                Registrada {formatDateTime(p.postedAt)}
              </p>
            )}
            <Badge tone={draft ? "neutral" : "success"}>
              {draft ? "Borrador" : "Registrada"}
            </Badge>
          </div>
        </header>

        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Forma de pago: {PAYMENT_LABELS[p.paymentMethod] ?? p.paymentMethod}
          {cur === "USD" && ` · Tasa de cambio ${p.exchangeRate}`}
        </p>

        {!draft && (
          <Datos606
            id={p.id}
            paymentDate={p.paymentDate}
            isrType={p.isrWithholdingType}
            itbisToCost={p.itbisToCost}
            itbisProportional={p.itbisProportional}
            hasIsr={Number(t.isrWithheld) > 0}
            hasItbis={Number(t.tax) > 0}
            credit={p.paymentMethod === "CREDIT"}
            onSaved={reload}
          />
        )}

        <div className={tableStyles.wrapper}>
          <table className={tableStyles.table}>
            <thead>
              <tr>
                <th className={tableStyles.th}>Descripción</th>
                <th className={`${tableStyles.th} text-right`}>Cant.</th>
                <th className={`${tableStyles.th} text-right`}>Costo</th>
                <th className={tableStyles.th}>Impuesto</th>
                <th className={`${tableStyles.th} text-right`}>Total</th>
              </tr>
            </thead>
            <tbody>
              {p.lines.map((l) => (
                <tr key={l.lineNumber}>
                  <td className={tableStyles.td}>
                    {l.name}
                    {Number(l.discount) > 0 && (
                      <div className="text-xs text-zinc-500">
                        Descuento {money(l.discount, cur)}
                      </div>
                    )}
                  </td>
                  <td className={`${tableStyles.td} text-right tabular-nums`}>
                    {l.quantity} <span className="text-xs text-zinc-500">{l.unit}</span>
                  </td>
                  <td className={`${tableStyles.td} text-right tabular-nums`}>
                    {money(l.unitCost, cur)}
                  </td>
                  <td className={tableStyles.td}>{TAX_LABELS[l.tax as TaxCode]}</td>
                  <td className={`${tableStyles.td} text-right tabular-nums`}>
                    {money(l.total, cur)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="grid gap-6 md:grid-cols-2">
          <div className="text-sm text-zinc-600 dark:text-zinc-400">
            {p.notes && (
              <p>
                <span className="text-xs uppercase tracking-wide text-zinc-500">
                  Notas:{" "}
                </span>
                {p.notes}
              </p>
            )}
          </div>
          <div className="space-y-1.5 text-sm tabular-nums">
            <Line label="Subtotal" value={money(t.subtotal, cur)} />
            {Number(t.tax18) > 0 && (
              <Line label={TAX_LABELS.ITBIS18} value={money(t.tax18, cur)} />
            )}
            {Number(t.tax16) > 0 && (
              <Line label={TAX_LABELS.ITBIS16} value={money(t.tax16, cur)} />
            )}
            <div className="flex justify-between border-t border-zinc-200 pt-2 text-lg font-semibold dark:border-zinc-800">
              <span>Total</span>
              <span>{money(t.total, cur)}</span>
            </div>
            {withheld > 0 && (
              <>
                {Number(t.itbisWithheld) > 0 && (
                  <Line
                    label="ITBIS retenido"
                    value={`−${money(t.itbisWithheld, cur)}`}
                  />
                )}
                {Number(t.isrWithheld) > 0 && (
                  <Line label="ISR retenido" value={`−${money(t.isrWithheld, cur)}`} />
                )}
              </>
            )}
          </div>
        </div>
      </article>

      {draft && (
        <div className="flex justify-end">
          <Button
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
              await run(async () => {
                await expectOk(
                  await api.v1.purchases[":id"].$delete({ param: { id: p.id } }),
                );
                toast("Borrador eliminado");
                router.push("/panel/compras");
              });
            }}
          >
            Eliminar borrador
          </Button>
        </div>
      )}
    </>
  );
}

/**
 * Datos del formato 606 que se completan aun con la compra registrada (no cambian la contabilidad): cuándo se pagó y,
 * si hubo retención de renta, de qué tipo, y cuánto del ITBIS se lleva al costo o queda sujeto a proporcionalidad.
 */
function Datos606({
  id,
  paymentDate,
  isrType,
  itbisToCost,
  itbisProportional,
  hasIsr,
  hasItbis,
  credit,
  onSaved,
}: {
  id: string;
  paymentDate: string | null;
  isrType: number | null;
  itbisToCost: string;
  itbisProportional: string;
  hasIsr: boolean;
  hasItbis: boolean;
  credit: boolean;
  onSaved: () => void;
}) {
  const { toast } = useDialogs();
  const [date, setDate] = useState(paymentDate ?? "");
  const [type, setType] = useState(isrType ? String(isrType) : "");
  const shown = (v: string) => (Number(v) > 0 ? v : "");
  const [toCost, setToCost] = useState(shown(itbisToCost));
  const [proportional, setProportional] = useState(shown(itbisProportional));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const amount = (v: string) => v.trim().replace(",", ".") || "0";
  const changed =
    date !== (paymentDate ?? "") ||
    type !== (isrType ? String(isrType) : "") ||
    Number(amount(toCost)) !== Number(itbisToCost) ||
    Number(amount(proportional)) !== Number(itbisProportional);
  const missing = hasIsr && !isrType;

  async function save() {
    setError(null);
    setBusy(true);
    try {
      await unwrap(
        await api.v1.purchases[":id"].dgii.$patch({
          param: { id },
          json: {
            paymentDate: date || null,
            ...(hasIsr ? { isrWithholdingType: type ? Number(type) : null } : {}),
            ...(hasItbis ? { itbisToCost: amount(toCost), itbisProportional: amount(proportional) } : {}),
          },
        }),
      );
      toast("Datos del 606 guardados");
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-3 rounded-md border border-zinc-200 p-4 dark:border-zinc-800">
      <h2 className="text-sm font-medium">Datos para el formato 606</h2>
      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Fecha de pago
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="rounded-md border border-zinc-300 bg-background px-3 py-2 text-sm dark:border-zinc-700"
          />
          <span className="text-xs font-normal text-zinc-500">
            {credit && !date ? "Compra a crédito: sin pagar todavía" : "Vacía: se toma la del comprobante"}
          </span>
        </label>
        {hasIsr && (
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Tipo de retención en ISR
            <select
              value={type}
              onChange={(e) => setType(e.target.value)}
              className="rounded-md border border-zinc-300 bg-background px-3 py-2 text-sm dark:border-zinc-700"
            >
              <option value="">Elegir…</option>
              {Object.entries(ISR_WITHHOLDING_TYPES).map(([k, label]) => (
                <option key={k} value={k}>
                  {k.padStart(2, "0")} · {label}
                </option>
              ))}
            </select>
            {missing && <span className="text-xs font-normal text-amber-700 dark:text-amber-400">Falta: el 606 no se puede enviar sin él</span>}
          </label>
        )}
        {hasItbis && (
          <>
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              ITBIS llevado al costo
              <input
                inputMode="decimal"
                placeholder="0.00"
                value={toCost}
                onChange={(e) => setToCost(e.target.value)}
                className="w-32 rounded-md border border-zinc-300 bg-background px-3 py-2 text-sm dark:border-zinc-700"
              />
              <span className="text-xs font-normal text-zinc-500">No se adelanta en el ITBIS</span>
            </label>
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              ITBIS por proporcionalidad
              <input
                inputMode="decimal"
                placeholder="0.00"
                value={proportional}
                onChange={(e) => setProportional(e.target.value)}
                className="w-32 rounded-md border border-zinc-300 bg-background px-3 py-2 text-sm dark:border-zinc-700"
              />
              <span className="text-xs font-normal text-zinc-500">Art. 349 de la Ley 11-92</span>
            </label>
          </>
        )}
        <Button variant="secondary" disabled={busy || !changed} onClick={save}>
          {busy ? "Guardando…" : "Guardar"}
        </Button>
      </div>
      <ErrorNote message={error} />
    </section>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-zinc-600 dark:text-zinc-400">{label}</span>
      <span>{value}</span>
    </div>
  );
}
