// Arranca la caja de verdad (Electron) con una carpeta de datos temporal y comprueba que la pantalla carga y que el
// puente IPC → motor → SQLite responde. Requiere haber compilado antes (`pnpm build`).
// Con `POS_EXE=<ruta al .exe>` prueba la caja ya empaquetada (`pnpm run pack` → dist/win-unpacked) en vez de la de desarrollo.
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const electron = process.env.POS_EXE || require("electron"); // ruta del ejecutable
const dir = await mkdtemp(join(tmpdir(), "pos-smoke-"));

const child = spawn(electron, process.env.POS_EXE ? [] : ["."], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  env: { ...process.env, POS_SMOKE: "1", POS_USER_DATA: dir },
  stdio: ["ignore", "pipe", "pipe"],
});

let out = "";
let err = "";
child.stdout.on("data", (d) => (out += d));
child.stderr.on("data", (d) => (err += d));

const code = await new Promise((resolve) => {
  child.on("error", (e) => {
    console.error("No se pudo iniciar Electron:", e.message);
    resolve(1);
  });
  child.on("exit", resolve);
});
await rm(dir, { recursive: true, force: true }).catch(() => undefined);

const line = out.split(/\r?\n/).find((l) => l.startsWith("{"));
if (!line) {
  console.error("La caja no devolvió resultado.\n", out, err);
  process.exit(1);
}
const result = JSON.parse(line);
console.log(JSON.stringify(result, null, 2));
if (code !== 0 || !result.ok) process.exit(1);
