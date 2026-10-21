import { useEffect, useMemo, useState } from "react";
import { calculateDocument, formatDop, toCents, toMilli, type TaxCode } from "@facturacion/core";
import type { LocalSale, Receipt, ReturnableLine } from "../../shared/api";
import { errorOf, Field, Modal } from "./ui";

const money = (cents: bigint) => formatDop(cents);
const METHODS = [
  { value: "CASH", label: "Efectivo" },
  { value: "CARD", label: "Tarjeta" },
  { value: "TRANSFER", label: "Transferencia" },
  { value: "CHECK", label: "Cheque" },
  { value: "OTHER", label: "Otro" },
] as const;

type Loaded = { encf: string; propinaLegal: boolean; lines: ReturnableLine[]; hasCredit: boolean };

/**
 * Devolución: se elige la venta, qué se devuelve y cómo se reembolsa. Genera una nota de crédito con su propio
 * e-NCF (sin internet). Anular la venta completa repone el inventario; una devolución parcial pregunta si la
 * mercancía vuelve al inventario.
 */
export function RefundModal({ initialSale, onClose, onDone }: { initialSale?: LocalSale; onClose: () => void; onDone: (receipt: Receipt) => void }) {
  const [sales, setSales] = useState<LocalSale[]>([]);
  const [q, setQ] = useState("");
  const [sale, setSale] = useState<LocalSale | null>(initialSale ?? null);

  useEffect(() => {
    if (!initialSale) window.pos.sales({ limit: 200 }).then((all) => setSales(all.filter((s) => s.type !== "E34" && s.status !== "REJECTED")), () => undefined);
  }, [initialSale]);

  if (!sale) {
    const list = sales.filter((s) => !q.trim() || s.encf.toLowerCase().includes(q.trim().toLowerCase()));
    return (
      <Modal title="Devolución" onClose={onClose}>
        <input autoFocus placeholder="Buscar por e-NCF…" value={q} onChange={(e) => setQ(e.target.value)} />
        <ul className="picklist">
          {list.map((s) => (
            <li key={s.id}>
              <button onClick={() => setSale(s)}>
                <span className="mono">{s.encf}</span> · {new Date(s.issuedAt).toLocaleString("es-DO")} · {formatDop(toCents(s.total))}
              </button>
            </li>
          ))}
          {list.length === 0 && <li className="muted empty">No hay ventas para devolver.</li>}
        </ul>
        <p className="muted small">Solo se pueden devolver ventas hechas en esta caja.</p>
      </Modal>
    );
  }
  return <RefundForm sale={sale} onBack={initialSale ? onClose : () => setSale(null)} onClose={onClose} onDone={onDone} />;
}

function RefundForm({ sale, onBack, onClose, onDone }: { sale: LocalSale; onBack: () => void; onClose: () => void; onDone: (receipt: Receipt) => void }) {
  const [data, setData] = useState<Loaded | null>(null);
  const [qty, setQty] = useState<Record<number, string>>({});
  const [method, setMethod] = useState<(typeof METHODS)[number]["value"]>("CASH");
  const [returnsStock, setReturnsStock] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    window.pos.returnable(sale.id).then((d) => {
      setData(d);
      setQty(Object.fromEntries(d.lines.map((l) => [l.index, l.remaining])));
    }, (e) => setError(errorOf(e)));
  }, [sale.id]);

  const chosen = useMemo(
    () => (data?.lines ?? []).map((l) => ({ line: l, quantity: (qty[l.index] ?? "0").replace(",", ".").trim() })).filter((x) => x.quantity !== "" && Number(x.quantity) > 0),
    [data, qty],
  );
  const total = useMemo(() => {
    try {
      if (!data || chosen.length === 0) return null;
      return calculateDocument({
        lines: chosen.map(({ line, quantity }) => ({
          unitPrice: toCents(line.unitPrice),
          quantity: toMilli(quantity),
          tax: line.tax as TaxCode,
          priceIncludesTax: line.priceIncludesTax,
        })),
        propinaLegal: data.propinaLegal,
      }).total;
    } catch {
      return null;
    }
  }, [data, chosen]);

  // Se anula todo si se devuelve cada línea completa y no hay otras notas: ahí el inventario se repone siempre.
  const full = !!data && !data.hasCredit && data.lines.every((l) => chosen.some((c) => c.line.index === l.index && toMilli(c.quantity) === toMilli(l.sold)));

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      onDone(
        await window.pos.refund({
          saleId: sale.id,
          items: chosen.map(({ line, quantity }) => ({ index: line.index, quantity })),
          method,
          returnsStock,
        }),
      );
    } catch (e) {
      setError(errorOf(e));
      setBusy(false);
    }
  }

  return (
    <Modal title={`Devolver ${sale.encf}`} onClose={onClose}>
      {!data && !error && <p className="muted">Cargando…</p>}
      {data && (
        <div className="stack">
          <table className="sales">
            <thead>
              <tr><th>Producto</th><th className="r">Vendido</th><th className="r">Ya devuelto</th><th className="r">Devolver</th></tr>
            </thead>
            <tbody>
              {data.lines.map((l) => (
                <tr key={l.index}>
                  <td>{l.name}<div className="small muted">{formatDop(toCents(l.unitPrice))} c/u</div></td>
                  <td className="r">{l.sold}</td>
                  <td className="r">{l.returned}</td>
                  <td className="r">
                    <input
                      aria-label={`Devolver ${l.name}`}
                      className="qty-input"
                      inputMode="decimal"
                      disabled={Number(l.remaining) === 0}
                      value={qty[l.index] ?? ""}
                      onChange={(e) => setQty((s) => ({ ...s, [l.index]: e.target.value }))}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Field label="¿Cómo se le devuelve el dinero?">
            <select value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
              {METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </Field>
          {full ? (
            <p className="notice">Se anula la venta completa: el inventario se repone automáticamente.</p>
          ) : (
            <label className="check"><input type="checkbox" checked={returnsStock} onChange={(e) => setReturnsStock(e.target.checked)} /> La mercancía vuelve al inventario</label>
          )}
          <button className="primary big" disabled={busy || total === null} onClick={() => void submit()}>
            {busy ? "Registrando…" : `Devolver ${total === null ? "" : money(total)}`}
          </button>
          <button className="link" onClick={onBack}>Volver</button>
        </div>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </Modal>
  );
}
