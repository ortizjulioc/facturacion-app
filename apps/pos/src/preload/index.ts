import { contextBridge, ipcRenderer } from "electron";
import { METHODS, type IpcResult, type PosBridge, type SyncReport, type UpdateState } from "../shared/api";

/**
 * Puente seguro entre la pantalla y el proceso principal: la pantalla recibe SOLO estos métodos (no tiene Node
 * ni acceso a `ipcRenderer`). Los errores del motor llegan como `Error` normales, con el mensaje en español.
 */
const api = Object.fromEntries(
  METHODS.map((name) => [
    name,
    async (...args: unknown[]) => {
      const res = (await ipcRenderer.invoke(`pos:${name}`, ...args)) as IpcResult<unknown>;
      if (!res.ok) throw Object.assign(new Error(res.error.message), { status: res.error.status });
      return res.value;
    },
  ]),
);

const bridge = {
  ...api,
  onSynced(callback: (report: SyncReport) => void) {
    const listener = (_e: unknown, report: SyncReport) => callback(report);
    ipcRenderer.on("pos:synced", listener);
    return () => ipcRenderer.removeListener("pos:synced", listener);
  },
  onPrintFailed(callback: (info: { saleId: string; message: string }) => void) {
    const listener = (_e: unknown, info: { saleId: string; message: string }) => callback(info);
    ipcRenderer.on("pos:print-failed", listener);
    return () => ipcRenderer.removeListener("pos:print-failed", listener);
  },
  onUpdate(callback: (state: UpdateState) => void) {
    const listener = (_e: unknown, state: UpdateState) => callback(state);
    ipcRenderer.on("pos:update", listener);
    return () => ipcRenderer.removeListener("pos:update", listener);
  },
} as unknown as PosBridge;

contextBridge.exposeInMainWorld("pos", bridge);
