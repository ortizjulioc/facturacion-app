import { useEffect, useState, type FormEvent } from "react";
import { formatDop, toCents } from "@facturacion/core";
import type { LocalShift, ShiftReport } from "../../shared/api";
import { errorOf, Field, Modal } from "./ui";

const money = (v: string) => formatDop(toCents(v));
const METHOD: Record<string, string> = { CASH: "Efectivo", CARD: "Tarjeta", TRANSFER: "Transferencia", CHECK: "Cheque", OTHER: "Otro" };
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("es-DO", { timeZone: "America/Santo_Domingo" }) : "—");

export function OpenShiftModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await window.pos.openShift(amount.replace(",", ".").trim() || "0");
      onDone();
    } catch (err) {
      setError(errorOf(err));
      setBusy(false);
    }
  }
  return (
    <Modal title="Abrir turno" onClose={onClose}>
      <form onSubmit={submit} className="stack">
        <Field label="Fondo de la gaveta (RD$)">
          <input autoFocus inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <p className="muted small">El efectivo con el que empieza la caja. Se cuenta al cerrar el turno.</p>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="primary" disabled={busy}>{busy ? "Abriendo…" : "Abrir turno"}</button>
      </form>
    </Modal>
  );
}

/** Cierre a ciegas: se cuenta la gaveta sin ver el esperado; si no cuadra, pide el motivo y muestra el informe Z. */
export function CloseShiftModal({ onClose, onDone }: { onClose: () => void; onDone: (closed: { shift: LocalShift; report: ShiftReport }) => void }) {
  const [counted, setCounted] = useState("");
  const [notes, setNotes] = useState("");
  const [needsReason, setNeedsReason] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onDone(await window.pos.closeShift({ countedCash: counted.replace(",", ".").trim(), notes: notes.trim() || null }));
    } catch (err) {
      const message = errorOf(err);
      setNeedsReason(/diferencia/i.test(message));
      setError(message);
      setBusy(false);
    }
  }
  return (
    <Modal title="Cerrar turno" onClose={onClose}>
      <form onSubmit={submit} className="stack">
        <Field label="Efectivo contado en la gaveta (RD$)">
          <input autoFocus required inputMode="decimal" placeholder="0.00" value={counted} onChange={(e) => setCounted(e.target.value)} />
        </Field>
        <p className="muted small">Cuenta todo el efectivo que hay ahora, incluido el fondo inicial.</p>
        <Field label={needsReason ? "Motivo de la diferencia" : "Observaciones (opcional)"}>
          <input value={notes} required={needsReason} maxLength={500} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="primary" disabled={busy}>{busy ? "Cerrando…" : "Cerrar turno"}</button>
      </form>
    </Modal>
  );
}

/** Informe X (turno abierto) o Z (cerrado), en formato de ticket para imprimir. */
export function ShiftReportModal({ shiftId, onClose }: { shiftId?: string; onClose: () => void }) {
  const [data, setData] = useState<{ shift: LocalShift; report: ShiftReport } | null | undefined>(undefined);
  useEffect(() => {
    window.pos.shiftReport(shiftId).then(setData, () => setData(null));
  }, [shiftId]);
  return (
    <Modal title={data?.shift.closedAt ? "Informe Z" : "Informe X del turno"} onClose={onClose}>
      {data === undefined && <p className="muted">Cargando…</p>}
      {data === null && <p className="muted">No hay un turno abierto.</p>}
      {data && <ShiftReportView shift={data.shift} report={data.report} />}
      {data && (
        <div className="row no-print">
          <button onClick={() => window.print()}>Imprimir</button>
          <button className="primary" onClick={onClose}>Cerrar</button>
        </div>
      )}
    </Modal>
  );
}

export function ShiftReportView({ shift, report }: { shift: LocalShift; report: ShiftReport }) {
  const closed = shift.closedAt !== null;
  const diff = report.difference !== undefined ? Number(report.difference) : null;
  return (
    <article className="receipt" aria-label="Informe del turno">
      <header>
        <strong>{closed ? "INFORME Z" : "INFORME X"}</strong>
        <div>{closed ? "Cierre de turno" : "Turno en curso"}</div>
      </header>
      <div className="rule" />
      <div>Abrió: {shift.openedBy.name ?? "—"}</div>
      <div>Apertura: {when(shift.openedAt)}</div>
      {closed && <div>Cierre: {when(shift.closedAt)}</div>}
      <div className="rule" />
      <dl>
        {(["E32", "E31", "E34"] as const)
          .filter((t) => report.byType[t].count > 0)
          .map((t) => (
            <div key={t}>
              <dt>{{ E32: "Consumo", E31: "Crédito fiscal", E34: "Notas de crédito" }[t]} × {report.byType[t].count}</dt>
              <dd>{t === "E34" ? "−" : ""}{money(report.byType[t].total)}</dd>
            </div>
          ))}
        {report.documents === 0 && <div><dt>Sin comprobantes</dt><dd /></div>}
        <div><dt>Subtotal</dt><dd>{money(report.sales.subtotal)}</dd></div>
        <div><dt>ITBIS</dt><dd>{money(report.sales.tax)}</dd></div>
        {Number(report.sales.propina) > 0 && <div><dt>Propina legal</dt><dd>{money(report.sales.propina)}</dd></div>}
        <div className="grand"><dt>VENTAS NETAS</dt><dd>{money(report.net)}</dd></div>
      </dl>
      <div className="rule" />
      <strong>Cobros (menos devoluciones)</strong>
      {Object.entries(report.payments).map(([m, amount]) => (
        <div key={m} className="pay"><span>{METHOD[m] ?? m}</span><span>{money(amount)}</span></div>
      ))}
      <div className="rule" />
      <dl>
        <div><dt>Fondo</dt><dd>{money(report.openingAmount)}</dd></div>
        <div><dt>Efectivo neto cobrado</dt><dd>{money(report.cashReceived)}</dd></div>
        <div className="grand"><dt>Efectivo esperado</dt><dd>{money(report.expectedCash)}</dd></div>
        {report.countedCash !== undefined && <div><dt>Efectivo contado</dt><dd>{money(report.countedCash)}</dd></div>}
        {diff !== null && (
          <div className="grand">
            <dt>{diff === 0 ? "Cuadra" : diff > 0 ? "Sobran" : "Faltan"}</dt>
            <dd>{diff === 0 ? "" : money(String(Math.abs(diff).toFixed(2)))}</dd>
          </div>
        )}
      </dl>
      {shift.notes && <div className="small">Observaciones: {shift.notes}</div>}
      {closed && (
        <div className="signs">
          <span>Cajero</span>
          <span>Supervisor</span>
        </div>
      )}
      {!shift.synced && <p className="small center-text no-print">Pendiente de subir a la nube.</p>}
    </article>
  );
}
