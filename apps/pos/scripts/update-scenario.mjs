// Prueba de la auto-actualización con la caja EMPAQUETADA contra la API de verdad:
//   1) Compila dos versiones con `electron-builder` (p. ej. 0.1.0 y 0.2.0) y deja en una carpeta, junto a latest.yml (el de la
//      versión nueva), el instalador y el .blockmap de las dos.
//   2) Arranca la API con POS_RELEASES_DIR=<esa carpeta> (apps/api: `pnpm dev`).
//   3) POS_EXE="<ruta a la caja vieja>/Caja Facturación.exe" POS_UPDATE_URL=http://localhost:3001/updates/caja \
//        node scripts/update-scenario.mjs
// Abre la caja vieja, le pide buscar una versión nueva (como lo hace sola cada 4 horas) y espera a que la descargue.
// Termina con éxito si queda «lista para instalar»; no instala (eso cierra el programa) ni toca la caja instalada.
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const exe = process.env.POS_EXE;
const feed = process.env.POS_UPDATE_URL;
const expect = process.env.POS_EXPECT_VERSION; // opcional: versión que debe aparecer
const port = Number(process.env.POS_DEBUG_PORT ?? 9333);
if (!exe || !feed) {
  console.error("Faltan POS_EXE (la caja empaquetada) y POS_UPDATE_URL (la dirección de las versiones).");
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = await mkdtemp(join(tmpdir(), "pos-update-"));
const child = spawn(exe, [`--remote-debugging-port=${port}`], {
  env: { ...process.env, POS_USER_DATA: dir, POS_UPDATE_FORCE: "1", POS_UPDATE_URL: feed },
  stdio: ["ignore", "ignore", "pipe"],
});
let err = "";
child.stderr.on("data", (d) => (err += d));
const stop = async () => {
  child.kill();
  await sleep(500);
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
};

/** Habla con la pantalla de la caja por el puerto de depuración (DevTools). */
async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = pages.find((p) => p.type === "page" && p.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* todavía arrancando */
    }
    await sleep(500);
  }
  throw new Error("La caja no abrió su pantalla. " + err);
}

try {
  const ws = new WebSocket(await connect());
  await new Promise((res, rej) => ((ws.onopen = res), (ws.onerror = () => rej(new Error("sin conexión a la pantalla")))));
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) pending.get(msg.id)(msg);
  };
  const evaluate = (expression) =>
    new Promise((res) => {
      const n = ++id;
      pending.set(n, (msg) => res(msg.result?.result?.value ?? msg.result?.exceptionDetails?.text));
      ws.send(JSON.stringify({ id: n, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
    });

  // La pantalla puede tardar en tener `window.pos`.
  for (let i = 0; i < 40 && (await evaluate("typeof window.pos?.updateState")) !== "function"; i++) await sleep(500);
  console.log("antes:", JSON.stringify(await evaluate("window.pos.updateState()")));
  await evaluate("window.pos.checkUpdates()");

  const started = Date.now();
  let state;
  while (Date.now() - started < 180_000) {
    state = await evaluate("window.pos.updateState()");
    if (state?.phase === "ready" || state?.phase === "error") break;
    await sleep(1000);
  }
  console.log("después:", JSON.stringify(state));
  const good = state?.phase === "ready" && (!expect || state.version === expect);
  console.log(good ? `OK: la versión ${state.version} se descargó y está lista para instalar.` : "FALLÓ: no quedó lista una versión nueva.");
  ws.close();
  await stop();
  process.exit(good ? 0 : 1);
} catch (e) {
  console.error(String(e));
  await stop();
  process.exit(1);
}
