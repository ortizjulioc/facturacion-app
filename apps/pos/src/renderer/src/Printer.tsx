import { useEffect, useState } from "react";
import type { PrinterConfig } from "../../shared/api";
import { errorOf, Field, Modal } from "./ui";

/** ¿Hay una impresora térmica configurada? Si no, se usa el diálogo de impresión del sistema. */
export const isPrintable = (c: PrinterConfig | null) => !!c && c.mode !== "none";

/**
 * Botón de imprimir: con térmica configurada manda el ticket por ESC/POS (y muestra el error si falla);
 * sin ella abre el diálogo de impresión del sistema.
 */
export function PrintButton({ printer, thermal }: { printer: PrinterConfig | null; thermal: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const printable = isPrintable(printer);
  async function click() {
    if (!printable) return window.print();
    setBusy(true);
    setError(null);
    try {
      await thermal();
    } catch (e) {
      setError(errorOf(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {error && <span className="error small" role="alert">{error}</span>}
      <button disabled={busy} onClick={() => void click()}>{busy ? "Imprimiendo…" : printable ? "Reimprimir" : "Imprimir"}</button>
    </>
  );
}

const MODES: { value: PrinterConfig["mode"]; label: string }[] = [
  { value: "none", label: "Sin impresora térmica (usar la del sistema)" },
  { value: "windows", label: "Impresora instalada en Windows" },
  { value: "network", label: "Impresora de red (IP)" },
];

export function PrinterModal({ onClose, onSaved }: { onClose: () => void; onSaved: (c: PrinterConfig) => void }) {
  const [config, setConfig] = useState<PrinterConfig | null>(null);
  const [printers, setPrinters] = useState<string[]>([]);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void window.pos.printerConfig().then(setConfig);
    void window.pos.printers().then(setPrinters, () => setPrinters([]));
  }, []);

  if (!config) return <Modal title="Impresora" onClose={onClose}><p className="muted">Cargando…</p></Modal>;
  const set = <K extends keyof PrinterConfig>(key: K, value: PrinterConfig[K]) => setConfig({ ...config, [key]: value });

  async function run(label: string, job: () => Promise<unknown>) {
    setBusy(true);
    setNotice(null);
    try {
      await job();
      setNotice({ tone: "ok", text: label });
    } catch (e) {
      setNotice({ tone: "error", text: errorOf(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Impresora" onClose={onClose}>
      <div className="stack">
        <Field label="Tipo de conexión">
          <select value={config.mode} onChange={(e) => set("mode", e.target.value as PrinterConfig["mode"])}>
            {MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </Field>

        {config.mode === "windows" && (
          <Field label="Impresora">
            <select value={config.name} onChange={(e) => set("name", e.target.value)}>
              <option value="">Elige una…</option>
              {printers.map((p) => <option key={p} value={p}>{p}</option>)}
              {config.name && !printers.includes(config.name) && <option value={config.name}>{config.name} (no aparece)</option>}
            </select>
          </Field>
        )}
        {config.mode === "network" && (
          <div className="payrow">
            <Field label="Dirección IP">
              <input value={config.host} placeholder="192.168.1.50" onChange={(e) => set("host", e.target.value)} />
            </Field>
            <Field label="Puerto">
              <input value={config.port} inputMode="numeric" onChange={(e) => set("port", Number(e.target.value.replace(/\D/g, "")) || 9100)} />
            </Field>
          </div>
        )}

        {config.mode !== "none" && (
          <>
            <div className="payrow">
              <Field label="Papel">
                <select value={config.paper} onChange={(e) => set("paper", Number(e.target.value) === 58 ? 58 : 80)}>
                  <option value={80}>80 mm</option>
                  <option value={58}>58 mm</option>
                </select>
              </Field>
              <Field label="Tildes y ñ">
                <select value={config.codePage} onChange={(e) => set("codePage", e.target.value as PrinterConfig["codePage"])}>
                  <option value="cp858">CP858 (recomendado)</option>
                  <option value="cp850">CP850</option>
                  <option value="cp437">CP437 (impresoras antiguas)</option>
                </select>
              </Field>
            </div>
            <label className="check"><input type="checkbox" checked={config.autoPrint} onChange={(e) => set("autoPrint", e.target.checked)} /> Imprimir el ticket al terminar cada venta o devolución</label>
            <label className="check"><input type="checkbox" checked={config.drawerOnCash} onChange={(e) => set("drawerOnCash", e.target.checked)} /> Abrir la gaveta cuando hay efectivo</label>
          </>
        )}

        {notice && <p className={notice.tone === "ok" ? "notice" : "error"} role={notice.tone === "ok" ? "status" : "alert"}>{notice.text}</p>}
        <div className="row">
          {config.mode !== "none" && (
            <>
              <button disabled={busy} onClick={() => void run("Prueba enviada a la impresora", () => window.pos.testPrint(config))}>Imprimir prueba</button>
              <button disabled={busy} onClick={() => void run("Gaveta abierta", async () => { await window.pos.savePrinterConfig(config); await window.pos.openDrawer(); })}>Abrir gaveta</button>
            </>
          )}
          <button
            className="primary"
            disabled={busy}
            onClick={async () => {
              const saved = await window.pos.savePrinterConfig(config);
              onSaved(saved);
              onClose();
            }}
          >
            Guardar
          </button>
        </div>
      </div>
    </Modal>
  );
}
