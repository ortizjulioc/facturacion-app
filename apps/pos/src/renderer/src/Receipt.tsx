import { ECF_LABELS, formatDop, toCents, type EcfType } from "@facturacion/core";
import type { Receipt } from "../../shared/api";

const m = (v: string) => formatDop(toCents(v));
const METHOD: Record<string, string> = { CASH: "Efectivo", CARD: "Tarjeta", TRANSFER: "Transferencia", CHECK: "Cheque", OTHER: "Otro" };

/** Ticket de 80 mm. Es lo que se imprime (el resto de la pantalla se oculta al imprimir). */
export function Receipt({ receipt }: { receipt: Receipt }) {
  const { sale, company } = receipt;
  const pending = sale.status === "PENDING";
  const credit = sale.type === "E34";
  return (
    <article className="receipt" aria-label="Comprobante">
      <header>
        <strong>{company?.tradeName ?? company?.legalName}</strong>
        {company && <div>{company.legalName}</div>}
        {company && <div>RNC {company.rnc}</div>}
        {company && <div>{company.address}</div>}
        {company?.phone && <div>Tel. {company.phone}</div>}
      </header>
      <div className="rule" />
      <div className="center-text">
        <strong>{ECF_LABELS[sale.type as EcfType]}</strong>
        <div>e-NCF: {sale.encf}</div>
        {credit && sale.refundOf && <div>Modifica: {sale.refundOf}</div>}
        <div>{new Date(sale.issuedAt).toLocaleString("es-DO", { timeZone: "America/Santo_Domingo" })}</div>
      </div>
      {receipt.buyerName && (
        <div>
          Cliente: {receipt.buyerName}
          {receipt.buyerDoc && <> · {receipt.buyerDoc}</>}
        </div>
      )}
      <div className="rule" />
      <table>
        <tbody>
          {receipt.lines.map((l, i) => (
            <tr key={i}>
              <td>
                {l.quantity} × {l.name}
                <div className="small">{m(l.unitPrice)} c/u</div>
              </td>
              <td className="r">{m(l.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="rule" />
      <dl>
        <div><dt>Subtotal</dt><dd>{m(receipt.totals.subtotal)}</dd></div>
        <div><dt>ITBIS</dt><dd>{m(receipt.totals.tax)}</dd></div>
        {Number(receipt.totals.propina) > 0 && <div><dt>Propina legal</dt><dd>{m(receipt.totals.propina)}</dd></div>}
        <div className="grand"><dt>TOTAL</dt><dd>{m(receipt.totals.total)}</dd></div>
      </dl>
      <div className="rule" />
      {credit && <div className="small">Reembolso</div>}
      {receipt.payments.map((p, i) => (
        <div key={i} className="pay"><span>{METHOD[p.method] ?? p.method}</span><span>{m(p.amount)}</span></div>
      ))}
      {receipt.cashierName && <div className="small">Atendió: {receipt.cashierName}</div>}
      {pending && <p className="small center-text no-print">Pendiente de subir a la nube (se envía sola al haber conexión).</p>}
      {!credit && <p className="small center-text">¡Gracias por su compra!</p>}
    </article>
  );
}
