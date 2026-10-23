import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { calculateDocument, formatDop, fromCents, toCents, toMilli, type TaxCode } from "@facturacion/core";
import type { LocalCustomer, LocalProduct, LocalSale, LocalShift, PosState, PrinterConfig, Receipt, SaleInput, ShiftReport, UpdateState } from "../../shared/api";
import { ReconnectModal } from "./Reconnect";
import { PrinterModal, PrintButton, isPrintable } from "./Printer";
import { RefundModal } from "./Refund";
import { CloseShiftModal, OpenShiftModal, ShiftReportModal, ShiftReportView } from "./Shifts";
import { Receipt as ReceiptView } from "./Receipt";
import { errorOf, Field, Modal } from "./ui";

type CartLine = { product: LocalProduct; quantity: string };
type PayRow = { key: number; method: SaleInput["payments"][number]["method"]; amount: string };

const METHODS: { value: PayRow["method"]; label: string }[] = [
  { value: "CASH", label: "Efectivo" },
  { value: "CARD", label: "Tarjeta" },
  { value: "TRANSFER", label: "Transferencia" },
  { value: "CHECK", label: "Cheque" },
  { value: "OTHER", label: "Otro" },
];

const money = (cents: bigint) => formatDop(cents);

/** Pantalla de venta: catálogo a la izquierda, carrito y cobro a la derecha. Todo funciona sin internet. */
export function Register({ state, reload }: { state: PosState; reload: () => void | Promise<void> }) {
  const [search, setSearch] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [products, setProducts] = useState<LocalProduct[]>([]);
  const [categories, setCategories] = useState<{ id: string; name: string }[]>([]);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [type, setType] = useState<"E32" | "E31">("E32");
  const [customer, setCustomer] = useState<LocalCustomer | null>(null);
  const [propina, setPropina] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [modal, setModal] = useState<null | "pay" | "customer" | "sales" | "reconnect" | "openShift" | "closeShift" | "xreport" | "refund" | "printer">(null);
  const [printer, setPrinter] = useState<PrinterConfig | null>(null);
  const [update, setUpdate] = useState<UpdateState | null>(null);
  const [confirmUpdate, setConfirmUpdate] = useState(false);
  const [printFailed, setPrintFailed] = useState<{ saleId: string; message: string } | null>(null);
  const [refundSale, setRefundSale] = useState<LocalSale | undefined>(undefined);
  const [zReport, setZReport] = useState<{ shift: LocalShift; report: ShiftReport } | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [syncing, setSyncing] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  // Impresora: se lee la configuración y se avisa cuando una impresión automática falla.
  useEffect(() => {
    void window.pos.printerConfig().then(setPrinter, () => undefined);
    return window.pos.onPrintFailed(setPrintFailed);
  }, []);

  // Actualización del programa: se descarga sola; el cajero decide cuándo reiniciar.
  useEffect(() => {
    void window.pos.updateState().then(setUpdate, () => undefined);
    return window.pos.onUpdate(setUpdate);
  }, []);

  // Catálogo (se vuelve a leer cuando termina una sincronización: cambia `state.products`).
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      window.pos.products(search, categoryId || undefined).then((p) => !cancelled && setProducts(p), () => undefined);
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [search, categoryId, state.products, state.lastSync?.at]);
  useEffect(() => {
    window.pos.categories().then(setCategories, () => undefined);
  }, [state.lastSync?.at]);

  const add = useCallback((product: LocalProduct) => {
    setMessage(null);
    setCart((c) => {
      const i = c.findIndex((l) => l.product.id === product.id);
      if (i < 0) return [...c, { product, quantity: "1" }];
      return c.map((l, j) => (j === i ? { ...l, quantity: String(Number(l.quantity) + 1) } : l));
    });
  }, []);

  /** El lector de códigos teclea el código y pulsa Enter: si coincide exacto, se agrega sin tocar nada más. */
  async function onEnter() {
    const code = search.trim();
    if (!code) return;
    const exact = await window.pos.productByBarcode(code);
    if (exact) {
      add(exact);
      setSearch("");
    } else if (products.length === 1) {
      add(products[0]!);
      setSearch("");
    } else {
      setMessage(products.length === 0 ? `No se encontró «${code}»` : "Elige el producto de la lista");
    }
  }

  const totals = useMemo(() => {
    try {
      const lines = cart.map((l) => ({
        unitPrice: BigInt(l.product.priceCents),
        quantity: toMilli(l.quantity),
        tax: l.product.tax as TaxCode,
        priceIncludesTax: l.product.priceIncludesTax,
      }));
      if (lines.length === 0 || lines.some((l) => l.quantity <= 0n)) return null;
      return calculateDocument({ lines, propinaLegal: propina });
    } catch {
      return null;
    }
  }, [cart, propina]);

  function setQuantity(id: string, quantity: string) {
    setCart((c) => c.map((l) => (l.product.id === id ? { ...l, quantity } : l)));
  }
  function step(line: CartLine, delta: number) {
    const next = Number(line.quantity) + delta;
    if (next <= 0) setCart((c) => c.filter((l) => l.product.id !== line.product.id));
    else setQuantity(line.product.id, String(next));
  }
  function clearSale() {
    setCart([]);
    setCustomer(null);
    setType("E32");
    setPropina(false);
    setMessage(null);
    searchRef.current?.focus();
  }

  async function syncNow() {
    setSyncing(true);
    try {
      const r = await window.pos.sync();
      setMessage(r.authRequired ? "Inicia sesión para sincronizar" : r.error);
      if (r.authRequired) setModal("reconnect");
    } catch (e) {
      setMessage(errorOf(e));
    } finally {
      setSyncing(false);
      void reload();
    }
  }

  const low = (n: number) => n < 20;
  const lastSync = state.lastSync;
  const online = lastSync?.ok === true;

  return (
    <div className="register" data-screen="register">
      <header className="topbar">
        <div className="brand">
          <strong>{state.company?.tradeName ?? state.company?.legalName ?? state.organization?.name}</strong>
          <span className="muted" title={update ? `Versión ${update.current}` : undefined}>{state.terminal?.name} · {state.cashier?.name ?? state.user?.name}</span>
        </div>
        <div className="statuses">
          <span className={`badge ${online ? "ok" : "warn"}`} title={lastSync ? `Última sincronización: ${new Date(lastSync.at).toLocaleString("es-DO")}` : "Aún no se ha sincronizado"}>
            {!state.signedIn ? "Sin sesión" : online ? "En línea" : "Sin conexión"}
          </span>
          {state.shift ? (
            <span className="badge ok" title={`Abierto por ${state.shift.openedBy.name ?? "—"}`}>Turno abierto {new Date(state.shift.openedAt).toLocaleTimeString("es-DO", { hour: "2-digit", minute: "2-digit" })}</span>
          ) : (
            <span className={`badge ${state.requireShift ? "bad" : ""}`}>Sin turno</span>
          )}
          <span
            className={`badge ${state.signing.certificate && !state.signing.certificate.problem ? "ok" : ""}`}
            title={
              state.signing.certificate
                ? `${state.signing.certificate.problem ?? "Esta caja firma los comprobantes sin internet"} · ${state.signing.certificate.subject} · vence ${new Date(state.signing.certificate.notAfter).toLocaleDateString("es-DO")}`
                : state.signing.available
                  ? "Sin certificado: se instala al sincronizar con una sesión de administrador"
                  : "Este equipo no tiene almacén seguro: la caja no puede guardar el certificado"
            }
          >
            {state.signing.certificate && !state.signing.certificate.problem ? "Firma local" : "Sin firma local"}
          </span>
          {update?.phase === "downloading" && <span className="badge" title={`Descargando la versión ${update.version}`}>Actualización {update.percent}%</span>}
          {state.pendingSales > 0 && <span className="badge warn">{state.pendingSales} por subir</span>}
          {state.shiftErrors.length > 0 && <span className="badge bad" title={state.shiftErrors.join(" · ")}>Turno sin subir</span>}
          {state.rejectedSales > 0 && <span className="badge bad">{state.rejectedSales} rechazadas</span>}
          <span className={`badge ${low(state.numbers.E32) ? "bad" : ""}`} title="Números de e-NCF que quedan para consumo">E32: {state.numbers.E32}</span>
          <span className={`badge ${low(state.numbers.E31) ? "bad" : ""}`} title="Números de e-NCF que quedan para crédito fiscal">E31: {state.numbers.E31}</span>
        </div>
        <div className="actions">
          {update?.phase === "ready" && (
            <button
              className="primary"
              title={`Versión ${update.version} lista. Se instala sola al cerrar la caja.`}
              onClick={() => (cart.length > 0 ? setConfirmUpdate(true) : void window.pos.installUpdate())}
            >
              Actualizar a v{update.version}
            </button>
          )}
          {!state.signedIn && <button onClick={() => setModal("reconnect")}>Iniciar sesión</button>}
          {state.shift ? (
            <>
              <button onClick={() => setModal("xreport")}>Informe X</button>
              <button onClick={() => setModal("closeShift")}>Cerrar turno</button>
            </>
          ) : (
            <button className={state.requireShift ? "primary" : ""} onClick={() => setModal("openShift")}>Abrir turno</button>
          )}
          <button onClick={() => { setRefundSale(undefined); setModal("refund"); }}>Devolución</button>
          <button onClick={() => void syncNow()} disabled={syncing || !state.signedIn}>{syncing ? "Sincronizando…" : "Sincronizar"}</button>
          <button onClick={() => setModal("sales")}>Ventas</button>
          {isPrintable(printer) && (
            <button onClick={() => void window.pos.openDrawer().catch((e: unknown) => setMessage(errorOf(e)))} title="Abrir la gaveta de dinero">Gaveta</button>
          )}
          <button onClick={() => setModal("printer")} title="Configurar la impresora">Impresora</button>
          {state.pinRequired && (
            <button onClick={() => void window.pos.lock().then(reload)} title="Bloquear la caja">Bloquear</button>
          )}
        </div>
      </header>

      <main className="layout">
        <section className="catalog">
          <div className="searchbar">
            <input
              ref={searchRef}
              autoFocus
              aria-label="Buscar producto o escanear código"
              placeholder="Buscar producto o escanear código de barras…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void onEnter()}
            />
            <select aria-label="Categoría" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">Todas</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
          {message && <p className="notice" role="status">{message}</p>}
          {printFailed && (
            <p className="notice" role="alert">
              No se pudo imprimir el ticket: {printFailed.message}{" "}
              <button
                className="link"
                onClick={() => {
                  const id = printFailed.saleId;
                  setPrintFailed(null);
                  void window.pos.printReceipt(id).catch((e: unknown) => setPrintFailed({ saleId: id, message: errorOf(e) }));
                }}
              >
                Reintentar
              </button>
              <button className="link" onClick={() => setPrintFailed(null)}>Cerrar</button>
            </p>
          )}
          <div className="grid">
            {products.map((p) => (
              <button key={p.id} className="tile" onClick={() => add(p)}>
                <span className="name">{p.name}</span>
                <span className="price">{money(BigInt(p.priceCents))}</span>
              </button>
            ))}
            {products.length === 0 && <p className="muted empty">{state.products === 0 ? "Aún no hay productos: sincroniza con el servidor." : "Sin resultados."}</p>}
          </div>
        </section>

        <aside className="cart" aria-label="Venta actual">
          <div className="cart-head">
            <h2>Venta actual</h2>
            {cart.length > 0 && <button className="link" onClick={clearSale}>Vaciar</button>}
          </div>
          <ul className="lines">
            {cart.length === 0 && <li className="muted empty">Agrega productos para empezar.</li>}
            {cart.map((l) => (
              <li key={l.product.id}>
                <div className="line-top">
                  <span>{l.product.name}</span>
                  <span className="tabular">{money(totalOf(l))}</span>
                </div>
                <div className="line-qty">
                  <button className="qty" aria-label="Quitar uno" onClick={() => step(l, -1)}>−</button>
                  <input
                    aria-label={`Cantidad de ${l.product.name}`}
                    className="qty-input"
                    inputMode="decimal"
                    value={l.quantity}
                    onChange={(e) => setQuantity(l.product.id, e.target.value.replace(",", "."))}
                  />
                  <button className="qty" aria-label="Agregar uno" onClick={() => step(l, 1)}>+</button>
                  <span className="muted">× {money(BigInt(l.product.priceCents))}</span>
                </div>
              </li>
            ))}
          </ul>

          <div className="options">
            <div className="seg" role="group" aria-label="Tipo de comprobante">
              <button className={type === "E32" ? "on" : ""} onClick={() => setType("E32")}>Consumo</button>
              <button className={type === "E31" ? "on" : ""} onClick={() => setType("E31")}>Crédito fiscal</button>
            </div>
            <button className="customer" onClick={() => setModal("customer")}>
              {customer ? `Cliente: ${customer.name}` : type === "E31" ? "Elegir cliente con RNC…" : "Cliente (opcional)…"}
            </button>
            <label className="check"><input type="checkbox" checked={propina} onChange={(e) => setPropina(e.target.checked)} /> Propina legal (10 %)</label>
          </div>

          <dl className="totals">
            <div><dt>Subtotal</dt><dd className="tabular">{money(totals?.subtotal ?? 0n)}</dd></div>
            <div><dt>ITBIS</dt><dd className="tabular">{money(totals?.totalTax ?? 0n)}</dd></div>
            {propina && <div><dt>Propina legal</dt><dd className="tabular">{money(totals?.propinaLegal ?? 0n)}</dd></div>}
            <div className="grand"><dt>Total</dt><dd className="tabular">{money(totals?.total ?? 0n)}</dd></div>
          </dl>
          <button
            className="primary big"
            disabled={!totals || (type === "E31" && !customer) || (state.requireShift && !state.shift)}
            onClick={() => setModal("pay")}
          >
            Cobrar {totals ? money(totals.total) : ""}
          </button>
          {type === "E31" && !customer && cart.length > 0 && <p className="muted small">El crédito fiscal necesita un cliente con RNC.</p>}
          {state.requireShift && !state.shift && <p className="muted small">Abre un turno para poder vender.</p>}
        </aside>
      </main>

      {modal === "customer" && (
        <CustomerModal
          requireRnc={type === "E31"}
          onClose={() => setModal(null)}
          onPick={(c) => {
            setCustomer(c);
            setModal(null);
          }}
          onClear={() => {
            setCustomer(null);
            setModal(null);
          }}
        />
      )}
      {modal === "pay" && totals && (
        <PayModal
          total={totals.total}
          onClose={() => setModal(null)}
          onPay={async (payments) => {
            const r = await window.pos.sell({
              type,
              customerId: customer?.id ?? null,
              propinaLegal: propina,
              lines: cart.map((l) => ({ productId: l.product.id, quantity: l.quantity })),
              payments,
            });
            setModal(null);
            setReceipt(r);
            clearSale();
            void reload();
          }}
        />
      )}
      {modal === "sales" && (
        <SalesModal
          onClose={() => setModal(null)}
          onChange={reload}
          onOpen={(r) => { setModal(null); setReceipt(r); }}
          onRefund={(s) => { setRefundSale(s); setModal("refund"); }}
        />
      )}
      {modal === "openShift" && <OpenShiftModal onClose={() => setModal(null)} onDone={() => { setModal(null); void reload(); }} />}
      {modal === "closeShift" && (
        <CloseShiftModal
          onClose={() => setModal(null)}
          onDone={(closed) => { setModal(null); setZReport(closed); void reload(); }}
        />
      )}
      {modal === "xreport" && <ShiftReportModal printer={printer} onClose={() => setModal(null)} />}
      {confirmUpdate && (
        <Modal title="Reiniciar para actualizar" onClose={() => setConfirmUpdate(false)}>
          <p>La caja se cerrará unos segundos y volverá a abrir sola con la versión {update?.version}. <strong>Hay productos en el carrito: se perderán.</strong></p>
          <div className="row">
            <button onClick={() => setConfirmUpdate(false)}>Seguir vendiendo</button>
            <button className="primary" onClick={() => void window.pos.installUpdate()}>Reiniciar y actualizar</button>
          </div>
        </Modal>
      )}
      {modal === "printer" && <PrinterModal onClose={() => setModal(null)} onSaved={setPrinter} />}
      {zReport && (
        <Modal title="Turno cerrado" onClose={() => setZReport(null)}>
          <ShiftReportView shift={zReport.shift} report={zReport.report} />
          <div className="row no-print">
            <PrintButton printer={printer} thermal={() => window.pos.printShift(zReport.shift.id)} />
            <button className="primary" onClick={() => setZReport(null)}>Listo</button>
          </div>
        </Modal>
      )}
      {modal === "refund" && (
        <RefundModal
          initialSale={refundSale}
          onClose={() => setModal(null)}
          onDone={(r) => { setModal(null); setReceipt(r); void reload(); }}
        />
      )}
      {modal === "reconnect" && <ReconnectModal state={state} onClose={() => setModal(null)} onDone={reload} />}
      {receipt && <ReceiptModal receipt={receipt} printer={printer} onClose={() => { setReceipt(null); searchRef.current?.focus(); }} />}
    </div>
  );
}

function totalOf(l: CartLine) {
  try {
    return calculateDocument({
      lines: [{ unitPrice: BigInt(l.product.priceCents), quantity: toMilli(l.quantity), tax: l.product.tax as TaxCode, priceIncludesTax: l.product.priceIncludesTax }],
    }).total;
  } catch {
    return 0n;
  }
}

function CustomerModal(props: { requireRnc: boolean; onPick: (c: LocalCustomer) => void; onClear: () => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<LocalCustomer[]>([]);
  useEffect(() => {
    const t = setTimeout(() => {
      window.pos.customers(q).then((r) => setResults(props.requireRnc ? r.filter((c) => c.documentType === "RNC") : r), () => undefined);
    }, 150);
    return () => clearTimeout(t);
  }, [q, props.requireRnc]);
  return (
    <Modal title={props.requireRnc ? "Cliente con RNC" : "Cliente"} onClose={props.onClose}>
      <input autoFocus placeholder="Buscar por nombre o documento…" value={q} onChange={(e) => setQ(e.target.value)} />
      <ul className="picklist">
        {results.map((c) => (
          <li key={c.id}>
            <button onClick={() => props.onPick(c)}>
              {c.name}
              {c.documentNumber && <span className="muted"> · {c.documentNumber}</span>}
            </button>
          </li>
        ))}
        {q && results.length === 0 && <li className="muted empty">Sin resultados.</li>}
      </ul>
      {!props.requireRnc && <button className="link" onClick={props.onClear}>Consumidor final</button>}
    </Modal>
  );
}

let payKey = 1;
function PayModal({ total, onClose, onPay }: { total: bigint; onClose: () => void; onPay: (payments: SaleInput["payments"]) => Promise<void> }) {
  const [rows, setRows] = useState<PayRow[]>([{ key: payKey++, method: "CASH", amount: "" }]);
  const [received, setReceived] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const single = rows.length === 1;
  // Con un solo pago y sin tocar el monto, se cobra el total exacto.
  const amountOf = (r: PayRow) => (single && r.amount === "" ? fromCents(total) : r.amount);
  let paid = 0n;
  let invalid = false;
  for (const r of rows) {
    try {
      paid += toCents(amountOf(r).replace(",", "."));
    } catch {
      invalid = true;
    }
  }
  const diff = paid - total;
  const balanced = !invalid && diff === 0n;

  let change = 0n;
  const cash = single && rows[0]!.method === "CASH";
  if (cash && received) {
    try {
      change = toCents(received.replace(",", ".")) - total;
    } catch {
      change = 0n;
    }
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await onPay(rows.map((r) => ({ method: r.method, amount: amountOf(r).replace(",", ".") })));
    } catch (e) {
      setError(errorOf(e));
      setBusy(false);
    }
  }

  return (
    <Modal title={`Cobrar ${money(total)}`} onClose={onClose}>
      <div className="stack">
        {rows.map((r) => (
          <div key={r.key} className="payrow">
            <select aria-label="Forma de pago" value={r.method} onChange={(e) => setRows((rs) => rs.map((x) => (x.key === r.key ? { ...x, method: e.target.value as PayRow["method"] } : x)))}>
              {METHODS.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
            <input
              aria-label="Monto"
              inputMode="decimal"
              value={amountOf(r)}
              onChange={(e) => setRows((rs) => rs.map((x) => (x.key === r.key ? { ...x, amount: e.target.value } : { ...x, amount: amountOf(x) })))}
            />
            {rows.length > 1 && (
              <button className="icon" aria-label="Quitar pago" onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}>✕</button>
            )}
          </div>
        ))}
        <button
          className="link"
          onClick={() => setRows((rs) => [...rs.map((x) => ({ ...x, amount: amountOf(x) })), { key: payKey++, method: "CARD", amount: "" }])}
        >
          Dividir el pago
        </button>

        {cash && (
          <Field label="Efectivo recibido (para el cambio)">
            <input inputMode="decimal" value={received} onChange={(e) => setReceived(e.target.value)} />
            {received && change >= 0n && <strong className="change">Cambio: {money(change)}</strong>}
          </Field>
        )}
        {!balanced && !invalid && <p className="notice">{diff < 0n ? "Faltan" : "Sobran"} {money(diff < 0n ? -diff : diff)}</p>}
        {error && <p className="error" role="alert">{error}</p>}
        <button className="primary big" disabled={!balanced || busy} onClick={() => void submit()}>
          {busy ? "Registrando…" : "Confirmar cobro"}
        </button>
      </div>
    </Modal>
  );
}

function ReceiptModal({ receipt, printer, onClose }: { receipt: Receipt; printer: PrinterConfig | null; onClose: () => void }) {
  return (
    <Modal title="Venta registrada" onClose={onClose}>
      <ReceiptView receipt={receipt} />
      {receipt.signWarning && <p className="notice no-print" role="status">Sin firma en esta venta: {receipt.signWarning}. La nube la firmará al sincronizar.</p>}
      <div className="row no-print">
        <PrintButton printer={printer} thermal={() => window.pos.printReceipt(receipt.sale.id, { reprint: true })} />
        <button className="primary" autoFocus onClick={onClose}>Nueva venta</button>
      </div>
    </Modal>
  );
}

const STATUS: Record<LocalSale["status"], { label: string; tone: string }> = {
  PENDING: { label: "Por subir", tone: "warn" },
  SYNCED: { label: "Sincronizada", tone: "ok" },
  REJECTED: { label: "Rechazada", tone: "bad" },
};

function SalesModal({ onClose, onChange, onOpen, onRefund }: { onClose: () => void; onChange: () => void | Promise<void>; onOpen: (r: Receipt) => void; onRefund: (s: LocalSale) => void }) {
  const [sales, setSales] = useState<LocalSale[] | null>(null);
  const load = useCallback(() => window.pos.sales({ limit: 100 }).then(setSales, () => setSales([])), []);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <Modal title="Ventas de esta caja" onClose={onClose} wide>
      <table className="sales">
        <thead>
          <tr><th>e-NCF</th><th>Fecha</th><th className="r">Total</th><th>Estado</th><th /></tr>
        </thead>
        <tbody>
          {sales?.map((s) => (
            <tr key={s.id}>
              <td className="mono">{s.encf}{s.type === "E34" && <div className="small muted">Nota de crédito de {s.refundOf}</div>}</td>
              <td>{new Date(s.issuedAt).toLocaleString("es-DO")}</td>
              <td className="r tabular">{money(toCents(s.total))}</td>
              <td>
                <span className={`badge ${STATUS[s.status].tone}`}>{STATUS[s.status].label}</span>
                {s.lastError && <div className="small error">{s.lastError}</div>}
              </td>
              <td className="r">
                <button className="link" onClick={() => void window.pos.receipt(s.id).then((r) => r && onOpen(r))}>Ver</button>
                {s.type !== "E34" && s.status !== "REJECTED" && (
                  <button className="link" onClick={() => onRefund(s)}>Devolver</button>
                )}
                {s.status === "REJECTED" && (
                  <button className="link" onClick={() => void window.pos.retrySale(s.id).then(() => Promise.all([load(), onChange()]))}>Reintentar</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {sales?.length === 0 && <p className="muted empty">Aún no hay ventas.</p>}
    </Modal>
  );
}
