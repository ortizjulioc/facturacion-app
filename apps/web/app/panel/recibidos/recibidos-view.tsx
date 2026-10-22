"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { formatDocument } from "@facturacion/core";
import {
  Badge,
  Button,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  Modal,
  PageHeader,
  Pagination,
  Select,
  Textarea,
  tableStyles,
} from "@/components/ui";
import { usePanel } from "@/components/panel-context";
import { useDialogs } from "@/components/dialogs";
import { API_URL, api, errorMessage, unwrap } from "@/lib/api";
import { formatDateTime, money } from "@/lib/format";
import { useDebounced, useQuery } from "@/lib/use-query";

const PAGE_SIZE = 20;

const TYPE_LABELS: Record<string, string> = {
  "31": "Crédito fiscal",
  "32": "Consumo",
  "33": "Nota de débito",
  "34": "Nota de crédito",
  "41": "Comprobante de compras",
  "43": "Gasto menor",
  "44": "Régimen especial",
  "45": "Gubernamental",
  "46": "Exportación",
  "47": "Pago al exterior",
};

type Row = Awaited<ReturnType<typeof fetchPage>>["data"][number];

async function fetchPage(params: { page: number; q: string; decision: string }) {
  return unwrap(
    await api.v1.received.$get({
      query: {
        page: String(params.page),
        pageSize: String(PAGE_SIZE),
        ...(params.q ? { q: params.q } : {}),
        ...(params.decision ? { decision: params.decision as "pending" | "approved" | "rejected" } : {}),
      },
    }),
  );
}

function statusOf(r: Row): { label: string; tone: "neutral" | "success" | "warning" } {
  if (!r.needsApproval) return { label: "Recibido", tone: "neutral" };
  if (r.approved === null) return { label: "Por responder", tone: "warning" };
  if (r.approvalState === "FAILED") return { label: "Respuesta sin entregar", tone: "warning" };
  if (r.approvalState === "PENDING") return { label: "Entregando respuesta", tone: "neutral" };
  return { label: r.approved ? "Aprobado" : "Rechazado", tone: r.approved ? "success" : "warning" };
}

export function RecibidosView() {
  const { canManage } = usePanel();
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim());
  const [page, setPage] = useState(1);
  const [decision, setDecision] = useState("");
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(() => fetchPage({ page, q, decision }), [page, q, decision]);
  const { data, error, reload } = useQuery(load);

  return (
    <>
      <PageHeader
        title="e-CF recibidos"
        description="Comprobantes que te envían tus proveedores. Cada uno se confirma solo con un acuse de recibo; tú decides si lo apruebas o lo rechazas comercialmente."
      />
      <ServicesNote />

      <div className="flex flex-wrap items-end gap-3">
        <Field label="Buscar" className="min-w-56 flex-1">
          <Input
            type="search"
            placeholder="e-NCF, proveedor o RNC"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        </Field>
        <Field label="Respuesta" className="w-48">
          <Select
            value={decision}
            onChange={(e) => {
              setDecision(e.target.value);
              setPage(1);
            }}
          >
            <option value="">Todos</option>
            <option value="pending">Por responder</option>
            <option value="approved">Aprobados</option>
            <option value="rejected">Rechazados</option>
          </Select>
        </Field>
      </div>

      <ErrorNote message={error} />

      <div className={tableStyles.wrapper}>
        <table className={tableStyles.table}>
          <thead>
            <tr>
              <th className={tableStyles.th}>Recibido</th>
              <th className={tableStyles.th}>e-NCF</th>
              <th className={tableStyles.th}>Emisor</th>
              <th className={`${tableStyles.th} text-right`}>Total</th>
              <th className={tableStyles.th}>Estado</th>
            </tr>
          </thead>
          <tbody>
            {data?.data.map((r) => {
              const st = statusOf(r);
              return (
                <tr
                  key={r.id}
                  tabIndex={0}
                  role="button"
                  onClick={() => setSelected(r.id)}
                  onKeyDown={(e) => e.key === "Enter" && setSelected(r.id)}
                  className="cursor-pointer hover:bg-zinc-50 focus:bg-zinc-50 dark:hover:bg-zinc-900 dark:focus:bg-zinc-900"
                >
                  <td className={`${tableStyles.td} whitespace-nowrap`}>{formatDateTime(r.receivedAt)}</td>
                  <td className={`${tableStyles.td} font-mono text-xs`}>
                    {r.encf}
                    <div className="font-sans text-zinc-500">{TYPE_LABELS[r.ecfType] ?? `Tipo ${r.ecfType}`}</div>
                  </td>
                  <td className={tableStyles.td}>
                    {r.emitterName ?? "—"}
                    <div className="text-xs text-zinc-500">{formatDocument("RNC", r.emitterRnc)}</div>
                  </td>
                  <td className={`${tableStyles.td} text-right tabular-nums`}>{money(r.total, "DOP")}</td>
                  <td className={tableStyles.td}>
                    <Badge tone={st.tone}>{st.label}</Badge>
                    {!r.signatureValid && <div className="text-xs text-amber-700 dark:text-amber-300">Firma inválida</div>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {data && data.data.length === 0 && (
          <EmptyState>
            {q || decision ? "Ningún comprobante coincide con los filtros." : "Aún no has recibido comprobantes de tus proveedores."}
          </EmptyState>
        )}
        {!data && !error && <EmptyState>Cargando…</EmptyState>}
      </div>

      {data && <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />}

      {selected && (
        <Detail
          id={selected}
          canManage={canManage}
          onClose={() => setSelected(null)}
          onChanged={reload}
        />
      )}
    </>
  );
}

/** Las direcciones que hay que registrar en la DGII para que los proveedores te envíen sus comprobantes. */
function ServicesNote() {
  const base = API_URL.replace(/\/+$/, "");
  return (
    <details className="rounded-md border border-zinc-200 p-3 text-sm dark:border-zinc-800">
      <summary className="cursor-pointer font-medium">Dónde reciben tus servicios</summary>
      <div className="mt-2 space-y-1 text-zinc-600 dark:text-zinc-400">
        <p>Estas son las direcciones que se registran en la DGII (Oficina Virtual) como tus servicios de receptor electrónico:</p>
        <p>
          Recepción de e-CF: <code className="font-mono text-xs">{base}/fe/recepcion/api/ecf</code>
        </p>
        <p>
          Aprobación comercial: <code className="font-mono text-xs">{base}/fe/aprobacioncomercial/api/ecf</code>
        </p>
        <p>Necesitas el certificado digital cargado para que se pueda firmar el acuse de recibo. La autenticación por semilla (opcional en el estándar) no está habilitada.</p>
      </div>
    </details>
  );
}

function Detail({ id, canManage, onClose, onChanged }: { id: string; canManage: boolean; onClose: () => void; onChanged: () => void }) {
  const { toast } = useDialogs();
  const load = useCallback(async () => (await unwrap(await api.v1.received[":id"].$get({ param: { id } }))).data, [id]);
  const { data: r, error, reload } = useQuery(load);
  const [reason, setReason] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  async function run(job: () => Promise<unknown>, done: string) {
    setActionError(null);
    setBusy(true);
    try {
      await job();
      toast(done);
      reload();
      onChanged();
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={r ? `e-CF ${r.encf}` : "e-CF recibido"}>
      <ErrorNote message={error} />
      {!r ? (
        <p className="text-sm text-zinc-500">Cargando…</p>
      ) : (
        <div className="space-y-4 text-sm">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
            <Item label="Emisor">
              {r.emitterName ?? "—"}
              <div className="text-xs text-zinc-500">{formatDocument("RNC", r.emitterRnc)}</div>
            </Item>
            <Item label="Tipo">{TYPE_LABELS[r.ecfType] ?? `Tipo ${r.ecfType}`}</Item>
            <Item label="Fecha de emisión">{r.issuedOnText}</Item>
            <Item label="Recibido">{formatDateTime(r.receivedAt)}</Item>
            <Item label="Total">{money(r.total, "DOP")}</Item>
            <Item label="ITBIS">{money(r.totalItbis, "DOP")}</Item>
            <Item label="Firma digital">
              {r.signatureValid ? <Badge tone="success">Íntegra</Badge> : <Badge tone="warning">Inválida</Badge>}
              {r.securityCode && <span className="ml-2 font-mono text-xs">{r.securityCode}</span>}
            </Item>
          </dl>

          {r.needsApproval ? (
            <section className="space-y-2 rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
              <p className="text-xs uppercase tracking-wide text-zinc-500">Respuesta comercial</p>
              {r.approved === null ? (
                canManage ? (
                  <div className="space-y-3">
                    <p className="text-zinc-600 dark:text-zinc-400">
                      Al responder se firma con el certificado de la empresa y se entrega al emisor y a la DGII. No se puede cambiar después.
                    </p>
                    {rejecting ? (
                      <>
                        <Field label="Motivo del rechazo">
                          <Textarea rows={3} maxLength={250} value={reason} onChange={(e) => setReason(e.target.value)} />
                        </Field>
                        <div className="flex justify-end gap-2">
                          <Button variant="secondary" disabled={busy} onClick={() => setRejecting(false)}>
                            Cancelar
                          </Button>
                          <Button
                            variant="danger"
                            disabled={busy || !reason.trim()}
                            onClick={() =>
                              run(async () => unwrap(await api.v1.received[":id"].decision.$post({ param: { id }, json: { approved: false, reason } })), "Rechazo enviado")
                            }
                          >
                            Rechazar comprobante
                          </Button>
                        </div>
                      </>
                    ) : (
                      <div className="flex justify-end gap-2">
                        <Button variant="secondary" disabled={busy} onClick={() => setRejecting(true)}>
                          Rechazar
                        </Button>
                        <Button
                          disabled={busy || !r.signatureValid}
                          onClick={() => run(async () => unwrap(await api.v1.received[":id"].decision.$post({ param: { id }, json: { approved: true } })), "Aprobación enviada")}
                        >
                          Aprobar
                        </Button>
                      </div>
                    )}
                    {!r.signatureValid && <p className="text-amber-700 dark:text-amber-300">Con la firma inválida solo se puede rechazar.</p>}
                  </div>
                ) : (
                  <p className="text-zinc-600 dark:text-zinc-400">Pendiente: solo propietarios y administradores pueden responder.</p>
                )
              ) : (
                <div className="space-y-1">
                  <p>
                    <Badge tone={r.approved ? "success" : "warning"}>{r.approved ? "Aprobado" : "Rechazado"}</Badge>
                    <span className="ml-2 text-zinc-500">{formatDateTime(r.decidedAt)}</span>
                  </p>
                  {r.approvalReason && <p className="text-zinc-600 dark:text-zinc-400">Motivo: {r.approvalReason}</p>}
                  <Delivery label="Emisor" at={r.peerSentAt} error={r.peerError} />
                  <Delivery label="DGII" at={r.dgiiSentAt} error={r.dgiiError} />
                  {r.approvalState === "PENDING" && r.approvalNextAt && (
                    <p className="text-zinc-500">Se reintenta solo (intento {r.approvalAttempts}; próximo {formatDateTime(r.approvalNextAt)}).</p>
                  )}
                  {r.approvalState === "FAILED" && canManage && (
                    <div className="flex justify-end">
                      <Button variant="secondary" disabled={busy} onClick={() => run(async () => unwrap(await api.v1.received[":id"].resend.$post({ param: { id } })), "Entrega reintentada")}>
                        Reintentar entrega
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </section>
          ) : (
            <p className="text-zinc-600 dark:text-zinc-400">Las facturas de consumo no llevan aprobación comercial.</p>
          )}

          <PurchasePanel id={id} receivedPurchaseId={r.purchaseId} canManage={canManage} onChanged={() => { reload(); onChanged(); }} />

          <ErrorNote message={actionError} />
          <div className="flex justify-between">
            <a className="text-sm underline" href={`${API_URL}/v1/received/${id}/xml`} target="_blank" rel="noreferrer">
              Descargar XML
            </a>
            <Button variant="secondary" onClick={onClose}>
              Cerrar
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-zinc-500">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Delivery({ label, at, error }: { label: string; at: string | Date | null; error: string | null }) {
  return (
    <p className="text-zinc-600 dark:text-zinc-400">
      {label}: {at ? <span className="text-emerald-700 dark:text-emerald-400">entregado {formatDateTime(at)}</span> : <span>pendiente</span>}
      {error && <span className="text-amber-700 dark:text-amber-300"> · {error}</span>}
    </p>
  );
}

/** Registrar el e-CF como compra: proveedor, ITBIS por línea y entrada al inventario de lo que se reconoce como producto. */
function PurchasePanel({ id, receivedPurchaseId, canManage, onChanged }: { id: string; receivedPurchaseId: string | null; canManage: boolean; onChanged: () => void }) {
  const { toast } = useDialogs();
  const router = useRouter();
  const [branchId, setBranchId] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const loadBranches = useCallback(async () => (await unwrap(await api.v1.branches.$get({ query: {} }))).data, []);
  const branches = useQuery(loadBranches);
  const loadPlan = useCallback(
    async () => (receivedPurchaseId || !canManage ? null : (await unwrap(await api.v1.received[":id"]["purchase-plan"].$get({ param: { id }, query: branchId ? { branchId } : {} }))).data),
    [id, branchId, receivedPurchaseId, canManage],
  );
  const { data: plan, error } = useQuery(loadPlan);

  if (receivedPurchaseId) {
    return (
      <p className="text-sm">
        Registrado como compra.{" "}
        <Link className="underline" href={`/panel/compras/${receivedPurchaseId}`}>
          Ver la compra
        </Link>
      </p>
    );
  }
  if (!canManage) return null;

  const needsBranch = !!error && /sucursal/i.test(error);
  async function register(post: boolean) {
    setActionError(null);
    setBusy(true);
    try {
      const res = await unwrap(await api.v1.received[":id"].purchase.$post({ param: { id }, json: { post, ...(branchId ? { branchId } : {}) } }));
      toast(post ? "Compra registrada" : "Borrador de compra creado");
      if (!post) router.push(`/panel/compras/${res.data.purchase.id}`);
      else onChanged();
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-2 rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
      <p className="text-xs uppercase tracking-wide text-zinc-500">Compra</p>
      {needsBranch && branches.data && (
        <Field label="Sucursal a la que entra la mercancía">
          <Select value={branchId} onChange={(e) => setBranchId(e.target.value)}>
            <option value="">Elige una…</option>
            {branches.data.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {error && !needsBranch && <p className="text-zinc-600 dark:text-zinc-400">{error}</p>}
      {plan && (
        <>
          <p className="text-zinc-600 dark:text-zinc-400">
            Proveedor: {plan.supplier.name} {plan.supplier.willCreate ? <Badge>Se creará</Badge> : <Badge tone="success">Ya existe</Badge>}
          </p>
          <ul className="space-y-0.5">
            {plan.lines.map((l) => (
              <li key={l.lineNumber} className="flex justify-between gap-3">
                <span>
                  {l.quantity} × {l.name}
                  <span className="ml-2 text-xs text-zinc-500">{l.match ? `→ ${l.match.productName}` : "sin producto (gasto)"}</span>
                </span>
                <span className="tabular-nums">{money(l.total, "DOP")}</span>
              </li>
            ))}
          </ul>
          {plan.warnings.map((w) => (
            <p key={w} className="text-amber-700 dark:text-amber-300">
              {w}
            </p>
          ))}
          <ErrorNote message={actionError} />
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" disabled={busy} onClick={() => register(false)}>
              Crear borrador y revisar
            </Button>
            <Button disabled={busy} onClick={() => register(true)}>
              Registrar compra
            </Button>
          </div>
        </>
      )}
      {needsBranch && !plan && <ErrorNote message={actionError} />}
    </section>
  );
}
