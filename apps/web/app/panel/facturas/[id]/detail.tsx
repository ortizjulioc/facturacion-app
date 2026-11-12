"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import {
  ECF_LABELS,
  formatDocument,
  formatTaxId,
  MODIFICATION_CODES,
  TAX_LABELS,
  type DocumentType,
  type EcfType,
  type ModificationCode,
  type TaxCode,
} from "@facturacion/core";
import { useDialogs } from "@/components/dialogs";
import { QrCode } from "@/components/qr-code";
import { usePanel } from "@/components/panel-context";
import { Badge, Button, ErrorNote, PageHeader, tableStyles } from "@/components/ui";
import { api, errorMessage, expectOk, unwrap } from "@/lib/api";
import {
  formatDate,
  formatDateTime,
  isDebitCredit,
  money,
  PAYMENT_LABELS,
  STATUS_LABELS,
  statusTone,
} from "@/lib/format";
import { useQuery } from "@/lib/use-query";

/** Fecha y hora de la firma como en el e-CF y los modelos de la DGII: «dd-MM-aaaa HH:mm:ss» en hora dominicana. */
const signedAtText = (at: string | Date) => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "America/Santo_Domingo",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(at))
      .map((x) => [x.type, x.value]),
  );
  return `${p.day}-${p.month}-${p.year} ${p.hour}:${p.minute}:${p.second}`;
};

const DELIVERY_LABELS: Record<string, string> = {
  PENDING: "Por entregar",
  DELIVERED: "Recibido por el comprador",
  NOT_RECEIVED: "El comprador no lo recibió",
  NOT_ELECTRONIC: "El comprador no es contribuyente electrónico",
  FAILED: "No se pudo entregar",
};
/** Motivos del acuse de recibo «no recibido» (Formato Acuse de Recibo v1.0). */
const NOT_RECEIVED_LABELS: Record<number, string> = {
  1: "Error de especificación",
  2: "Error de firma digital",
  3: "Envío duplicado",
  4: "El RNC del comprador no corresponde",
};

const linkButton =
  "inline-flex items-center justify-center rounded-md px-3.5 py-2 text-sm font-medium transition";

export function InvoiceDetail({ id }: { id: string }) {
  const router = useRouter();
  const { confirm, toast } = useDialogs();
  const { canManage } = usePanel();
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
                  {canManage && doc.ecf && !doc.fiscal && !doc.fiscalBlock && (
                    <Button
                      variant="secondary"
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          await unwrap(await api.v1.documents[":id"].send.$post({ param: { id: doc.id } }));
                          toast("Comprobante en cola para la DGII");
                          reload();
                        })
                      }
                    >
                      Enviar a la DGII
                    </Button>
                  )}
                  {doc.status === "REJECTED" && (
                    <Button
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          const res = await unwrap(await api.v1.documents[":id"].replace.$post({ param: { id: doc.id } }));
                          router.push(`/panel/facturas/${res.data.id}/editar`);
                        })
                      }
                    >
                      Sustituir con otro comprobante
                    </Button>
                  )}
                  {canManage && doc.fiscal && doc.fiscal.state === "FAILED" && (
                    <Button
                      variant="secondary"
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          await unwrap(await api.v1.documents[":id"].send.$post({ param: { id: doc.id } }));
                          reload();
                        })
                      }
                    >
                      Reintentar envío
                    </Button>
                  )}
                  {canManage && doc.fiscal && (doc.fiscal.state === "PENDING" || doc.fiscal.state === "SENT") && (
                    <Button
                      variant="secondary"
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          await unwrap(await api.v1.documents[":id"].fiscal.refresh.$post({ param: { id: doc.id } }));
                          reload();
                        })
                      }
                    >
                      Consultar ahora
                    </Button>
                  )}
                  {!doc.ecf && canManage && doc.currency === "DOP" && (
                    <Button
                      variant="secondary"
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          await unwrap(await api.v1.documents[":id"].sign.$post({ param: { id: doc.id } }));
                          toast("e-CF firmado");
                          reload();
                        })
                      }
                    >
                      Firmar e-CF
                    </Button>
                  )}
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
                {company.legalName}
                <br />
                RNC {formatTaxId(company.rnc)}
                <br />
                Dirección: {company.address}
                {[company.municipality, company.province].filter(Boolean).length > 0 && `, ${[company.municipality, company.province].filter(Boolean).join(", ")}`}
                <br />
                <span className="font-medium">Fecha Emisión:</span> {formatDate(doc.issuedAt ?? doc.createdAt)}
              </p>
            )}
          </div>
          <div className="text-right text-sm">
            <p className="font-medium">{ECF_LABELS[type]}</p>
            <p>
              <span className="font-medium">e-NCF:</span> <span className="font-mono">{doc.encf ?? "Sin número (borrador)"}</span>
            </p>
            {/* Modelos de representación impresa de la DGII: vencimiento de la secuencia en el 31 y el 33; NCF modificado
                y su motivo en las notas. */}
            {(type === "E31" || type === "E33") && doc.sequenceExpiry && (
              <p>
                <span className="font-medium">Fecha Vencimiento:</span> {formatDate(doc.sequenceExpiry)}
              </p>
            )}
            {doc.referencedEncf && (
              <>
                <p>
                  <span className="font-medium">NCF Modificado:</span> <span className="font-mono">{doc.referencedEncf}</span>
                </p>
                {doc.modificationCode && <p className="font-medium">{MODIFICATION_CODES[doc.modificationCode as ModificationCode]}</p>}
              </>
            )}
            <p className="no-print text-zinc-600 dark:text-zinc-400">{formatDateTime(doc.issuedAt ?? doc.createdAt)}</p>
            <span className="no-print">
              <Badge tone={statusTone(doc.status)}>{STATUS_LABELS[doc.status] ?? doc.status}</Badge>
            </span>
          </div>
        </header>

        <section className="text-sm">
          <p className="text-xs uppercase tracking-wide text-zinc-500">Comprador</p>
          <p>
            <span className="font-medium">Razón Social Cliente:</span> {doc.buyerName ?? "Consumidor final"}
          </p>
          {doc.buyerDocType && doc.buyerDocNumber && (
            <p>
              <span className="font-medium">{doc.buyerDocType === "PASAPORTE" ? "Pasaporte" : "RNC Cliente"}:</span>{" "}
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
                <th className={`${tableStyles.th} text-right`}>Cantidad</th>
                <th className={tableStyles.th}>Descripción</th>
                <th className={tableStyles.th}>Unidad de Medida</th>
                <th className={`${tableStyles.th} text-right`}>Precio</th>
                <th className={`${tableStyles.th} text-right`}>ITBIS</th>
                <th className={`${tableStyles.th} text-right`}>Valor</th>
              </tr>
            </thead>
            <tbody>
              {doc.lines.map((l) => (
                <tr key={l.lineNumber} className="break-inside-avoid">
                  <td className={`${tableStyles.td} text-right tabular-nums`}>{l.quantity}</td>
                  <td className={tableStyles.td}>
                    {l.name}
                    {Number(l.discount) > 0 && (
                      <div className="text-xs text-zinc-500">
                        Descuento {money(l.discount, cur)}
                      </div>
                    )}
                  </td>
                  <td className={tableStyles.td}>{l.unit}</td>
                  <td className={`${tableStyles.td} text-right tabular-nums`}>
                    {money(l.unitPrice, cur)}
                  </td>
                  <td className={`${tableStyles.td} text-right tabular-nums`} title={TAX_LABELS[l.tax as TaxCode]}>
                    {/* «E» marca las líneas exentas, como en la representación impresa de la DGII. */}
                    {l.tax === "EXENTO" ? "E" : money(l.taxAmount, cur)}
                  </td>
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
                {doc.paymentDueDate && (
                  <div className="flex justify-between">
                    <span>Fecha límite de pago</span>
                    <span>{formatDate(doc.paymentDueDate)}</span>
                  </div>
                )}
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
            {!draft && canManage && ["E31", "E32", "E33", "E34"].includes(doc.type) && (
              <Retenciones
                id={doc.id}
                retentions={doc.retentions}
                onSaved={reload}
              />
            )}
          </div>

          <div className="space-y-1.5 text-sm tabular-nums">
            <Line label="Subtotal Gravado" value={money(String(Number(totals.base18) + Number(totals.base16) + Number(totals.base0)), cur)} />
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
        {(doc.fiscal || doc.fiscalBlock) && !draft && (
          <section className="no-print space-y-1 rounded-md border border-zinc-200 p-3 text-sm dark:border-zinc-800">
            <p className="text-xs uppercase tracking-wide text-zinc-500">
              Envío a la DGII{doc.fiscal?.kind === "RFCE" ? " · resumen de factura de consumo (RFCE)" : ""}
            </p>
            {doc.fiscal ? (
              <>
                <p>
                  <Badge tone={doc.fiscal.state === "FAILED" || doc.status === "REJECTED" ? "warning" : doc.fiscal.state === "DONE" ? "success" : "neutral"}>
                    {fiscalLabel(doc.fiscal.state, doc.fiscal.dgiiStatus)}
                  </Badge>
                  {doc.fiscal.trackId && <span className="ml-2 font-mono text-xs text-zinc-500">TrackId {doc.fiscal.trackId}</span>}
                </p>
                {doc.fiscal.messages.map((m, i) => (
                  <p key={i} className="text-zinc-600 dark:text-zinc-400">
                    {m.text}
                  </p>
                ))}
                {doc.fiscal.lastError && <p className="text-amber-700 dark:text-amber-300">{doc.fiscal.lastError}</p>}
                {doc.status === "REJECTED" && doc.fiscal.sequenceUsed !== null && (
                  <p className="text-zinc-600 dark:text-zinc-400">
                    {doc.fiscal.sequenceUsed ? "El e-NCF quedó gastado." : "El e-NCF no se gastó (la DGII lo considera libre)."} Sustitúyelo con otro comprobante: se emite con un e-NCF nuevo y no vuelve a descontar inventario.
                  </p>
                )}
                {(doc.fiscal.state === "PENDING" || doc.fiscal.state === "SENT") && doc.fiscal.attempts > 0 && (
                  <p className="text-zinc-500">Intentos: {doc.fiscal.attempts} · próximo {formatDateTime(doc.fiscal.nextAttemptAt)}</p>
                )}
              </>
            ) : (
              <p className="text-zinc-600 dark:text-zinc-400">{doc.fiscalBlock}</p>
            )}
          </section>
        )}
        {doc.delivery && (
          <section className="no-print rounded-md border border-zinc-200 p-3 text-sm dark:border-zinc-800">
            <p className="text-xs uppercase tracking-wide text-zinc-500">Entrega al comprador (contribuyente electrónico)</p>
            <p>
              <Badge tone={doc.delivery.state === "DELIVERED" ? "success" : doc.delivery.state === "PENDING" || doc.delivery.state === "NOT_ELECTRONIC" ? "neutral" : "warning"}>
                {DELIVERY_LABELS[doc.delivery.state] ?? doc.delivery.state}
              </Badge>
              {doc.delivery.deliveredAt && <span className="ml-2 text-zinc-500">{formatDateTime(doc.delivery.deliveredAt)}</span>}
            </p>
            {doc.delivery.reason && <p className="text-zinc-600 dark:text-zinc-400">Motivo del comprador: {NOT_RECEIVED_LABELS[doc.delivery.reason] ?? doc.delivery.reason}</p>}
            {doc.delivery.error && <p className="text-zinc-600 dark:text-zinc-400">{doc.delivery.error}</p>}
            {canManage && ["FAILED", "NOT_RECEIVED", "NOT_ELECTRONIC"].includes(doc.delivery.state) && (
              <Button
                variant="secondary"
                className="mt-2"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await unwrap(await api.v1.documents[":id"].deliver.$post({ param: { id: doc.id } }));
                    reload();
                  })
                }
              >
                Reintentar entrega
              </Button>
            )}
          </section>
        )}
        {doc.approval && (
          <section className="no-print rounded-md border border-zinc-200 p-3 text-sm dark:border-zinc-800">
            <p className="text-xs uppercase tracking-wide text-zinc-500">Respuesta comercial del cliente</p>
            <p>
              <Badge tone={doc.approval.approved ? "success" : "warning"}>{doc.approval.approved ? "Aprobó el comprobante" : "Rechazó el comprobante"}</Badge>
              {doc.approval.at && <span className="ml-2 text-zinc-500">{doc.approval.at}</span>}
            </p>
            {doc.approval.reason && <p className="text-zinc-600 dark:text-zinc-400">Motivo: {doc.approval.reason}</p>}
          </section>
        )}
        {doc.ecf && (
          <footer className="flex items-center gap-4 border-t border-zinc-200 pt-4 text-sm dark:border-zinc-800">
            {doc.ecf.qrUrl && <QrCode text={doc.ecf.qrUrl} label="Código QR para verificar el comprobante en la DGII" />}
            <div className="space-y-1">
              <p className="font-medium">Comprobante firmado electrónicamente</p>
              <p className="text-zinc-600 dark:text-zinc-400">
                Código de Seguridad: <span className="font-mono">{doc.ecf.securityCode}</span>
                <br />
                Fecha Firma: {signedAtText(doc.ecf.signedAt)}
              </p>
              {doc.ecf.qrUrl && <p className="text-xs text-zinc-500">Escanee el código para verificarlo en la DGII.</p>}
            </div>
          </footer>
        )}
        {/* Leyendas de los modelos de representación impresa de la DGII. */}
        {doc.offline && doc.ecf && (
          <p className="text-sm font-medium italic">
            e-CF emitido en modalidad de Contingencia, el cual podrá ser consultado para su validez fiscal, a partir de las
            setenta y dos (72) horas.
          </p>
        )}
        {!draft && !doc.ecf && (
          <p className="text-sm font-medium italic">
            Documento no válido para fines fiscales: el comprobante electrónico aún no está firmado.
          </p>
        )}
        {doc.status === "REJECTED" && (
          <p className="text-sm font-medium italic">Documento no válido para fines fiscales: la DGII lo rechazó.</p>
        )}
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

/**
 * Retenciones que el cliente nos hizo al pagar (ITBIS y renta), con su fecha. Van en el formato 607 y se anotan aquí
 * porque se conocen después de emitir; el comprobante no cambia.
 */
function Retenciones({
  id,
  retentions,
  onSaved,
}: {
  id: string;
  retentions: { itbisWithheld: string; isrWithheld: string; date: string | null };
  onSaved: () => void;
}) {
  const { toast } = useDialogs();
  const [itbis, setItbis] = useState(Number(retentions.itbisWithheld) > 0 ? retentions.itbisWithheld : "");
  const [isr, setIsr] = useState(Number(retentions.isrWithheld) > 0 ? retentions.isrWithheld : "");
  const [date, setDate] = useState(retentions.date ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const num = (v: string) => v.trim().replace(",", ".") || "0";

  async function save() {
    setError(null);
    setBusy(true);
    try {
      await unwrap(
        await api.v1.documents[":id"].retentions.$patch({
          param: { id },
          json: { itbisWithheld: num(itbis), isrWithheld: num(isr), date: date || null },
        }),
      );
      toast("Retenciones guardadas");
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const field = "rounded-md border border-zinc-300 bg-background px-3 py-2 text-sm dark:border-zinc-700";
  return (
    <section className="space-y-2 rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
      <p className="text-xs uppercase tracking-wide text-zinc-500">Retenciones del cliente (formato 607, en pesos)</p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs font-medium">
          ITBIS retenido
          <input className={`${field} w-28`} inputMode="decimal" placeholder="0.00" value={itbis} onChange={(e) => setItbis(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium">
          Renta retenida
          <input className={`${field} w-28`} inputMode="decimal" placeholder="0.00" value={isr} onChange={(e) => setIsr(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium">
          Fecha de retención
          <input className={field} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <Button variant="secondary" disabled={busy} onClick={save}>
          {busy ? "Guardando…" : "Guardar"}
        </Button>
      </div>
      <ErrorNote message={error} />
    </section>
  );
}

const fiscalLabel = (state: string, dgii: string | null) =>
  state === "PENDING" ? "En cola para enviar" : state === "SENT" ? "Enviado: esperando resultado" : state === "FAILED" ? "Requiere revisión" : (dgii ?? "Resultado recibido");

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-zinc-600 dark:text-zinc-400">{label}</span>
      <span>{value}</span>
    </div>
  );
}
