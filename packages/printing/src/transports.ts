import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { printerProblem, type PrinterConfig } from "./config";

/** No se pudo imprimir. El mensaje está en español y se muestra tal cual al cajero. */
export class PrintError extends Error {
  override name = "PrintError";
}

/** Manda los bytes a una impresora de red (puerto 9100 o el que corresponda). */
export function sendToNetwork(host: string, port: number, bytes: Uint8Array, timeoutMs = 8000): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err);
      else resolve();
    };
    socket.setTimeout(timeoutMs, () => done(new PrintError(`La impresora ${host}:${port} no responde`)));
    socket.once("error", (e: NodeJS.ErrnoException) =>
      done(
        new PrintError(
          e.code === "ECONNREFUSED" || e.code === "EHOSTUNREACH" || e.code === "ENOTFOUND"
            ? `No se pudo conectar con la impresora en ${host}:${port}. Revisa la dirección y que esté encendida`
            : `Error de red al imprimir: ${e.message}`,
        ),
      ),
    );
    socket.once("connect", () => {
      // `end` vacía lo escrito y cierra: al terminar, la impresora ya recibió todo.
      socket.end(Buffer.from(bytes), () => setTimeout(() => done(), 50));
    });
  });
}

// Escritura en crudo (RAW) en una impresora instalada en Windows: sin controlador gráfico, directo al spooler.
const RAW_PRINTER_CS = `
using System;
using System.Runtime.InteropServices;
public class RawPrinterException : Exception {
  public string Step; public int Code;
  public RawPrinterException(string step, int code) : base(step + " " + code) { Step = step; Code = code; }
}
public static class RawPrinter {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DOCINFO {
    [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
  }
  [DllImport("winspool.drv", EntryPoint = "OpenPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool OpenPrinter(string name, out IntPtr h, IntPtr pd);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv", EntryPoint = "StartDocPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern int StartDocPrinter(IntPtr h, int level, [In] DOCINFO di);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool WritePrinter(IntPtr h, byte[] buf, int count, out int written);
  public static void Send(string printer, byte[] bytes) {
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero)) throw new RawPrinterException("OpenPrinter", Marshal.GetLastWin32Error());
    try {
      var di = new DOCINFO { pDocName = "Ticket", pDataType = "RAW" };
      if (StartDocPrinter(h, 1, di) == 0) throw new RawPrinterException("StartDocPrinter", Marshal.GetLastWin32Error());
      try {
        if (!StartPagePrinter(h)) throw new RawPrinterException("StartPagePrinter", Marshal.GetLastWin32Error());
        int written;
        if (!WritePrinter(h, bytes, bytes.Length, out written) || written != bytes.Length)
          throw new RawPrinterException("WritePrinter", Marshal.GetLastWin32Error());
        EndPagePrinter(h);
      } finally { EndDocPrinter(h); }
    } finally { ClosePrinter(h); }
  }
}`;

const POWERSHELL_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
${RAW_PRINTER_CS}
'@
$bytes = [System.IO.File]::ReadAllBytes($env:POS_PRINT_FILE)
try { [RawPrinter]::Send($env:POS_PRINTER, $bytes) }
catch {
  $e = $_.Exception
  while ($e.InnerException) { $e = $e.InnerException }
  if ($e -is [RawPrinterException]) { [Console]::Error.WriteLine('POS_ERR|' + $e.Step + '|' + $e.Code) } else { [Console]::Error.WriteLine('POS_ERR|Unknown|0') }
  exit 2
}
`;

/** Códigos de error de Windows más comunes al abrir o escribir en una impresora. */
export function windowsPrintMessage(name: string, step?: string, code?: number): string {
  if (code === 1801) return `No se encontró la impresora «${name}»: revisa el nombre en la configuración`;
  if (code === 5) return `Windows no permite imprimir en «${name}» (sin permiso)`;
  if (code === 1796 || code === 1722) return `Windows no pudo conectar con la impresora «${name}»`;
  if (code === 1788 || code === 21) return `La impresora «${name}» no está lista (apagada, sin papel o desconectada)`;
  return `No se pudo imprimir en «${name}»${step ? ` (${step}${code ? ` ${code}` : ""})` : ""}`;
}

/** Manda los bytes en crudo a una impresora instalada en Windows, por su nombre. */
export async function sendToWindowsPrinter(name: string, bytes: Uint8Array, timeoutMs = 30_000): Promise<void> {
  if (process.platform !== "win32") throw new PrintError("Imprimir por nombre de impresora solo está disponible en Windows");
  const dir = await mkdtemp(join(tmpdir(), "pos-print-"));
  const file = join(dir, `${randomUUID()}.bin`);
  try {
    await writeFile(file, bytes);
    const encoded = Buffer.from(POWERSHELL_SCRIPT, "utf16le").toString("base64");
    const result = await new Promise<{ code: number | null; err: string }>((resolve, reject) => {
      const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
        env: { ...process.env, POS_PRINTER: name, POS_PRINT_FILE: file },
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe"],
      });
      let err = "";
      child.stderr.on("data", (d) => (err += d));
      const timer = setTimeout(() => {
        child.kill();
        reject(new PrintError("La impresora tardó demasiado en responder"));
      }, timeoutMs);
      child.once("error", (e) => {
        clearTimeout(timer);
        reject(new PrintError(`No se pudo iniciar PowerShell: ${e.message}`));
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        resolve({ code, err });
      });
    });
    if (result.code !== 0) {
      const m = /POS_ERR\|(\w+)\|(\d+)/.exec(result.err);
      throw new PrintError(windowsPrintMessage(name, m?.[1], m?.[2] ? Number(m[2]) : undefined));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Envía los bytes según la configuración. Lanza `PrintError` con un mensaje claro si algo falla. */
export async function printBytes(config: PrinterConfig, bytes: Uint8Array): Promise<void> {
  const problem = printerProblem(config);
  if (problem) throw new PrintError(problem);
  if (config.mode === "network") return sendToNetwork(config.host, config.port, bytes);
  return sendToWindowsPrinter(config.name, bytes);
}
