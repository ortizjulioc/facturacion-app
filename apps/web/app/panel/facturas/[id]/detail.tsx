"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import {
  ECF_LABELS,
  formatDocument,
  TAX_LABELS,
  type DocumentType,
  type EcfType,
  type TaxCode,
} from "@facturacion/core";
import { useDialogs } from "@/components/dialogs";
import { Badge, Button, ErrorNote, PageHeader, tableStyles } from "@/components/ui";
import { api, errorMessage, expectOk, unwrap } from "@/lib/api";
import {
  formatDateTime,
  isDebitCredit,
  money,
  PAYMENT_LABELS,
  STATUS_LABELS,
  statusTone,
} from "@/lib/format";
import { useQuery } from "@/lib/use-query";

const linkButton =
  "inline-flex items-center justify-center rounded-md px-3.5 py-2 text-sm font-medium transition";

export function InvoiceDetail({ id }: { id: string }) {
  const router = useRouter();
  const { confirm, toast } = useDialogs();
  const load = useMemo(
    () => async () => {
      const [doc, company] = await Promise.all([
        unwrap(await api.v1.documents[":id"].$get({ param: { id } })),
        unwrap(await api.v1.company.$get()),
      ]);
      return { doc: doc.data, company: company.data };
    },
    [id],
  );
  const { data, error, reload } = useQuery(load);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  if (error) return <ErrorNote message={error} />;
  if (!data) return <p className="text-sm text-zinc-500">Cargando…</p>;

  const { doc, company } = data;
  const type = doc.type as EcfType;
  const cur = doc.currency;
  const draft = doc.status === "DRAFT";

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

  const totals = doc.totals;
  const taxRows: [string, string][] = [
    [TAX_LABELS.ITBIS18, totals.tax18],
    [TAX_LABELS.ITBIS16, totals.tax16],
  ];

  return (
    <>
      <div className="no-print">
        <PageHeader
          title={doc.encf ?? `Borrador de ${ECF_LABELS[type].toLowerCase()}`}
          description={`${ECF_LABELS[type]}${doc.referencedEncf ? ` · modifica ${doc.referencedEncf}` : ""}`}
          actions={
            <>
              {draft ? (
                <>
                  <Link
                    href={`/panel/facturas/${doc.id}/editar`}
                    className={`${linkButton} border border-zinc-300 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900`}
                  >
                    Editar
                  </Link>
                  <Button
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        const issued = await unwrap(
                          await api.v1.documents[":id"].issue.$post({
                            param: { id: doc.id },
                          }),
                        );
                        toast(`Comprobante emitido: ${issued.data.encf}`);
                        reload();
                      })
                    }
                  >
                    Emitir
                  </Button>
                </>
              ) : (
                <>
                  <Button variant="secondary" onClick={() => window.print()}>
                    Imprimir
                  </Button>
                  {!isDebitCredit(type) && (
                    <>
                      <Link
                        href={`/panel/facturas/nueva?type=E34&ref=${doc.id}`}
                        className={`${linkButton} border border-zinc-300 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900`}
                      >
                        Nota de crédito
                      </Link>
                      <Link
                        href={`/panel/facturas/nueva?type=E33&ref=${doc.id}`}
                        className={`${linkButton} border border-zinc-300 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900`}
                      >
                        Nota de débito
                      </Link>
                    </>
                  )}
                </>
              )}
            </>
          }
        />
        <ErrorNote message={actionError} />
      </div>

      <article className="space-y-6 rounded-lg border border-zinc-200 p-6 print:border-0 print:p-0 dark:border-zinc-800">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-lg font-semibold">
              {company?.tradeName || company?.legalName || "Emisor"}
            </p>
            {company && (
              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                {company.legalName} · RNC {formatDocument("RNC", company.rnc)}
                <br />
                {company.address}
              </p>
            )}
          </div>
          <div className="text-right text-sm">
            <p className="font-medium">{ECF_LABELS[type]}</p>
            <p className="font-mono">{doc.encf ?? "Sin número (borrador)"}</p>
            <p className="text-zinc-600 dark:text-zinc-400">
              {formatDateTime(doc.issuedAt ?? doc.createdAt)}
            </p>
            <Badge tone={statusTone(doc.status)}>
              {STATUS_LABELS[doc.status] ?? doc.status}
            </Badge>
          </div>
        </header>

        <section className="text-sm">
          <p className="text-xs uppercase tracking-wide text-zinc-500">Comprador</p>
          <p className="font-medium">{doc.buyerName ?? "Consumidor final"}</p>
          {doc.buyerDocType && doc.buyerDocNumber && (
            <p className="text-zinc-600 dark:text-zinc-400">
              {doc.buyerDocType}{" "}
              {formatDocument(doc.buyerDocType as DocumentType, doc.buyerDocNumber)}
            </p>
          )}
          {cur === "USD" && (
            <p className="text-zinc-600 dark:text-zinc-400">
              Tasa de cambio: {doc.exchangeRate}
            </p>
          )}
        </section>

        <div className={tableStyles.wrapper}>
          <table className={tableStyles.table}>
            <thead>
              <tr>
                <th className={tableStyles.th}>Descripción</th>
                <th className={`${tableStyles.th} text-right`}>Cant.</th>
                <th className={`${tableStyles.th} text-right`}>Precio</th>
                <th className={tableStyles.th}>Impuesto</th>
                <th className={`${tableStyles.th} text-right`}>Total</th>
              </tr>
            </thead>
            <tbody>
              {doc.lines.map((l) => (
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
                    {money(l.unitPrice, cur)}
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
          <div className="space-y-2 text-sm">
            {doc.payments.length > 0 && (
              <>
                <p className="text-xs uppercase tracking-wide text-zinc-500">Pagos</p>
                {doc.payments.map((p) => (
                  <div key={p.id} className="flex justify-between tabular-nums">
                    <span>
                      {PAYMENT_LABELS[p.method] ?? p.method}
                      {p.reference && (
                        <span className="ml-2 text-zinc-500">{p.reference}</span>
                      )}
                    </span>
                    <span>{money(p.amount, cur)}</span>
                  </div>
                ))}
              </>
            )}
            {doc.notes && (
              <p className="pt-2 text-zinc-600 dark:text-zinc-400">
                <span className="text-xs uppercase tracking-wide text-zinc-500">
                  Notas:{" "}
                </span>
                {doc.notes}
              </p>
            )}
          </div>

          <div className="space-y-1.5 text-sm tabular-nums">
            <Line label="Subtotal" value={money(totals.subtotal, cur)} />
            {Number(totals.discount) > 0 && (
              <Line label="Descuentos incluidos" value={money(totals.discount, cur)} />
            )}
            {taxRows
              .filter(([, v]) => Number(v) > 0)
              .map(([label, v]) => (
                <Line key={label} label={label} value={money(v, cur)} />
              ))}
            {Number(totals.baseExempt) > 0 && (
              <Line label="Monto exento" value={money(totals.baseExempt, cur)} />
            )}
            {Number(totals.propina) > 0 && (
              <Line label="Propina legal 10 %" value={money(totals.propina, cur)} />
            )}
            <div className="flex justify-between border-t border-zinc-200 pt-2 text-lg font-semibold dark:border-zinc-800">
              <span>Total</span>
              <span>{money(totals.total, cur)}</span>
            </div>
          </div>
        </div>
      </article>

      {draft && (
        <div className="no-print flex justify-end">
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
                  await api.v1.documents[":id"].$delete({ param: { id: doc.id } }),
                );
                toast("Borrador eliminado");
                router.push("/panel/facturas");
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

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-zinc-600 dark:text-zinc-400">{label}</span>
      <span>{value}</span>
    </div>
  );
}
