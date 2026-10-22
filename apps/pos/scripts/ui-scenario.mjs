// Escenario de verificación de la interfaz con la caja REAL (Electron) contra una API local en marcha.
//   1) cd apps/api && pnpm dev          (API en http://localhost:3001)
//   2) cd apps/pos && pnpm build
//   3) POS_SCRIPT=scripts/ui-scenario.mjs POS_SHOTS=<carpeta> pnpm smoke
// Crea una empresa nueva en la nube, configura la caja desde la pantalla, vende, sube y deja capturas en POS_SHOTS.
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { generateKeyPairSync } from "node:crypto";

const API = process.env.POS_API ?? "http://localhost:3001";
const ORIGIN = "app://facturacion-pos";

class Cloud {
  cookies = new Map();
  async call(method, path, body) {
    const res = await fetch(API + path, {
      method,
      headers: {
        origin: ORIGIN,
        ...(body ? { "content-type": "application/json" } : {}),
        ...(this.cookies.size ? { cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ") } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const i = pair.indexOf("=");
      this.cookies.set(pair.slice(0, i), pair.slice(i + 1));
    }
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json)}`);
    return json;
  }
}

/** Certificado .p12 autofirmado de prueba (RSA 2048), generado con node-forge del paquete ecf. */
function makeP12(password) {
  const forge = createRequire(new URL("../../../packages/ecf/package.json", import.meta.url))("node-forge");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const key = forge.pki.privateKeyFromPem(privateKey.export({ type: "pkcs8", format: "pem" }));
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.setRsaPublicKey(key.n, key.e);
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date(Date.now() - 86_400_000);
  cert.validity.notAfter = new Date(Date.now() + 365 * 86_400_000);
  const attrs = [{ name: "commonName", value: "COLMADO DEMO SRL" }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(key, forge.md.sha256.create());
  const der = forge.asn1.toDer(forge.pkcs12.toPkcs12Asn1(key, [cert], password, { algorithm: "3des" })).getBytes();
  return Buffer.from(der, "binary").toString("base64");
}

async function seed() {
  const c = new Cloud();
  const stamp = Date.now();
  const email = `caja${stamp}@example.com`;
  const password = "una-clave-bien-larga-123";
  await c.call("POST", "/api/auth/sign-up/email", { name: "Cajera Demo", email, password });
  const org = await c.call("POST", "/api/auth/organization/create", { name: "Colmado Demo", slug: `colmado-${stamp}` });
  await c.call("POST", "/api/auth/organization/set-active", { organizationId: org.id });
  await c.call("PUT", "/v1/company", { rnc: "1-01-00157-7", legalName: "Colmado Demo SRL", tradeName: "Colmado Demo", address: "Av. Principal 12, Santo Domingo", phone: "809-555-0100", environment: "TEST", requireShift: true });
  await c.call("PUT", "/v1/company/certificate", { p12: makeP12("clave-demo"), password: "clave-demo" });
  await c.call("PUT", "/v1/pins/me", { pin: "2580" });
  const branch = (await c.call("POST", "/v1/branches", { name: "Principal", code: "P1" })).data;
  await c.call("POST", "/v1/terminals", { branchId: branch.id, name: "Caja 1", code: "C1" });
  await c.call("POST", "/v1/sequences", { ecfType: "E32", fromNumber: 1, toNumber: 1000, expiresAt: "2099-12-31" });
  await c.call("POST", "/v1/sequences", { ecfType: "E31", fromNumber: 1, toNumber: 300, expiresAt: "2099-12-31" });
  await c.call("POST", "/v1/sequences", { ecfType: "E34", fromNumber: 1, toNumber: 300, expiresAt: "2099-12-31" });
  const cat = (await c.call("POST", "/v1/categories", { name: "Bebidas" })).data;
  for (const [name, price, barcode] of [["Agua 500 ml", "35.00", "7461001"], ["Refresco 2 L", "118.00", "7461002"], ["Cerveza", "90.00", "7461003"], ["Pan de agua", "10.00", "7461004"], ["Arroz 5 lb", "236.00", "7461005"]]) {
    await c.call("POST", "/v1/products", { name, price, barcode, ...(name.startsWith("Agua") || name.startsWith("Ref") || name.startsWith("Cerv") ? { categoryId: cat.id } : {}) });
  }
  await c.call("POST", "/v1/customers", { name: "Acme SRL", documentType: "RNC", documentNumber: "131246796" });
  return { email, password };
}

/** Impresora de red simulada: guarda cada trabajo (conexión) que recibe. */
async function fakePrinter() {
  const jobs = [];
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    const chunks = [];
    socket.on("data", (d) => chunks.push(d));
    socket.on("close", () => {
      sockets.delete(socket);
      if (chunks.length) jobs.push(Buffer.concat(chunks));
    });
  });
  const listen = (port = 0) => new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server.address().port)));
  const port = await listen();
  return {
    jobs,
    port,
    stop: () => new Promise((resolve) => { for (const s of sockets) s.destroy(); server.close(() => resolve()); }),
    start: () => listen(port),
  };
}
const has = (buf, bytes) => buf.indexOf(Buffer.from(bytes)) >= 0;
const summarize = (buf) => ({
  bytes: buf.length,
  drawer: has(buf, [0x1b, 0x70, 0x00, 0x19, 0xfa]),
  cut: has(buf, [0x1d, 0x56, 0x42, 0x00]),
  qr: has(buf, [0x1d, 0x28, 0x6b]),
  title: ["FACTURA DE CONSUMO", "NOTA DE CR", "INFORME Z", "PRUEBA"].find((t) => buf.toString("latin1").includes(t)) ?? null,
  encf: buf.toString("latin1").match(/E3\d{11}/)?.[0] ?? null,
});

export default async function scenario({ run, sleep, shot }) {
  const out = { shots: [] };
  const printer = await fakePrinter();
  const { email, password } = await seed();

  // Utilidades que corren dentro de la pantalla (React: se asigna con el setter nativo y se dispara `input`).
  const helpers = `
    window.__setv = (el, v) => { const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v); el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); };
    window.__btn = (t, root = document) => [...root.querySelectorAll('button')].find((b) => b.innerText.trim().startsWith(t));
    window.__wait = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const r = fn(); if (r) return r; await new Promise((x) => setTimeout(x, 100)); } throw new Error('Tiempo agotado esperando la pantalla: ' + document.body.innerText.slice(0, 200)); };
    true;`;
  await run(helpers);
  const snap = async (name) => out.shots.push(await shot(name));

  // 1) Configuración desde la pantalla.
  await snap("01-configurar");
  await run(`(async () => {
    const f = document.querySelector('form');
    const [server, mail, pass] = f.querySelectorAll('input');
    __setv(server, ${JSON.stringify(API)}); __setv(mail, ${JSON.stringify(email)}); __setv(pass, ${JSON.stringify(password)});
    __btn('Conectar').click();
    await __wait(() => __btn('Configurar esta caja'));
    __btn('Configurar esta caja').click();
    await __wait(() => document.querySelector('[data-screen=lock]'), 20000);
    return true;
  })()`);

  // 1b) Bloqueo con PIN: un PIN equivocado no entra; el correcto sí (con el teclado de la pantalla).
  await sleep(500);
  await snap("02-bloqueo");
  out.pin = await run(`(async () => {
    const press = async (digits) => { for (const d of digits) { __btn(d, document.querySelector('.keypad')).click(); await new Promise((r) => setTimeout(r, 60)); } __btn('OK', document.querySelector('.keypad')).click(); await new Promise((r) => setTimeout(r, 500)); };
    await press('9999');
    const wrong = document.querySelector('[role=alert]')?.innerText ?? null;
    await press('2580');
    await __wait(() => document.querySelector('[data-screen=register]'), 8000);
    return { wrong };
  })()`);
  await sleep(400);
  await snap("03-venta-sin-turno");

  // 1c) La empresa exige turno: Cobrar está bloqueado hasta abrirlo.
  out.requireShift = await run(`(async () => {
    const input = document.querySelector('input[aria-label^="Buscar"]');
    __setv(input, '7461004'); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise((r) => setTimeout(r, 400));
    const blocked = __btn('Cobrar').disabled;
    __btn('Vaciar').click();
    await new Promise((r) => setTimeout(r, 200));
    __btn('Abrir turno').click();
    await __wait(() => document.querySelector('.modal'));
    __setv(document.querySelector('.modal input'), '500');
    __btn('Abrir turno', document.querySelector('.modal')).click();
    await __wait(() => !document.querySelector('.modal'));
    return { blocked, badge: document.querySelector('.statuses').innerText.replace(/\\n/g, ' · ') };
  })()`);
  await sleep(300);
  await snap("04-venta-vacia");

  // 1d) Impresora de red (simulada): configurar desde la pantalla, imprimir la prueba y guardar.
  out.printerSetup = await run(`(async () => {
    __btn('Impresora').click();
    await __wait(() => document.querySelector('.modal'));
    const modal = () => document.querySelector('.modal');
    __setv(modal().querySelector('select'), 'network');
    await __wait(() => modal().querySelector('input[placeholder="192.168.1.50"]'));
    __setv(modal().querySelector('input[placeholder="192.168.1.50"]'), '127.0.0.1');
    const portInput = [...modal().querySelectorAll('input')].find((i) => i.inputMode === 'numeric');
    __setv(portInput, '${printer.port}');
    await new Promise((r) => setTimeout(r, 200));
    __btn('Imprimir prueba', modal()).click();
    await __wait(() => /Prueba enviada/.test(modal().innerText), 10000);
    return modal().innerText.replace(/\\n+/g, ' / ');
  })()`);
  await snap("04b-impresora");
  await run(`__btn('Guardar', document.querySelector('.modal')).click()`);
  await sleep(400);
  out.setup = await run(`window.pos.state().then((s) => ({ stage: s.stage, products: s.products, numbers: s.numbers, terminal: s.terminal?.name, company: s.company?.legalName }))`);

  // 2) Venta con lector de códigos: dos escaneos del mismo producto y uno distinto.
  out.cart = await run(`(async () => {
    const input = document.querySelector('input[aria-label^="Buscar"]');
    const scan = async (code) => { __setv(input, code); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await new Promise((r) => setTimeout(r, 400)); };
    await scan('7461002'); await scan('7461002'); await scan('7461003');
    return [...document.querySelectorAll('.lines li')].map((l) => l.innerText.replace(/\\n/g, ' | '));
  })()`);
  await snap("05-carrito");

  // 3) Cobro: dividir el pago en efectivo y tarjeta.
  await run(`(async () => {
    __btn('Cobrar').click();
    await __wait(() => document.querySelector('.modal'));
  })()`);
  await sleep(300);
  await snap("06-cobro");
  out.pay = await run(`(async () => {
    const modal = document.querySelector('.modal');
    __btn('Dividir el pago', modal).click();
    await new Promise((r) => setTimeout(r, 200));
    const amounts = [...modal.querySelectorAll('input[aria-label=Monto]')];
    __setv(amounts[0], '200.00'); await new Promise((r) => setTimeout(r, 150));
    const total = modal.querySelector('h2').innerText.match(/[\\d,]+\\.\\d{2}/)[0].replace(',', '');
    __setv(modal.querySelectorAll('input[aria-label=Monto]')[1], (Number(total) - 200).toFixed(2));
    await new Promise((r) => setTimeout(r, 200));
    const confirm = __btn('Confirmar cobro', modal);
    const enabled = !confirm.disabled;
    confirm.click();
    await __wait(() => document.querySelector('.receipt'));
    return { total, enabled, receipt: document.querySelector('.receipt').innerText.replace(/\\n+/g, ' / ') };
  })()`);
  await sleep(300);
  await snap("07-ticket");

  // 4) Nueva venta, sincronizar y ver el historial.
  out.sync = await run(`(async () => {
    __btn('Nueva venta').click();
    await new Promise((r) => setTimeout(r, 300));
    __btn('Sincronizar').click();
    await __wait(() => !document.querySelector('.badge.warn') || !/por subir/.test(document.querySelector('.statuses').innerText), 15000);
    const s = await window.pos.state();
    return { pending: s.pendingSales, lastSync: s.lastSync?.ok, statuses: document.querySelector('.statuses').innerText.replace(/\\n/g, ' · ') };
  })()`);
  await run(`__btn('Ventas').click()`);
  await sleep(500);
  await snap("08-historial");
  out.sales = await run(`[...document.querySelectorAll('.sales tbody tr')].map((r) => r.innerText.replace(/\\s+/g, ' '))`);

  // 4b) Devolver 1 refresco en efectivo desde el historial.
  out.refund = await run(`(async () => {
    [...document.querySelectorAll('.modal button')].find((b) => b.innerText.trim() === 'Devolver').click();
    await __wait(() => document.querySelector('.modal input[aria-label^="Devolver"]'));
    const inputs = [...document.querySelectorAll('.modal input[aria-label^="Devolver"]')];
    __setv(inputs[0], '1'); __setv(inputs[1], '0');
    await new Promise((r) => setTimeout(r, 300));
    const label = [...document.querySelectorAll('.modal button')].find((b) => /^Devolver RD/.test(b.innerText.trim())).innerText.trim();
    window.__refundLabel = label;
    return label;
  })()`);
  await snap("09-devolucion");
  out.refundDone = await run(`(async () => {
    [...document.querySelectorAll('.modal button')].find((b) => /^Devolver RD/.test(b.innerText.trim())).click();
    await __wait(() => document.querySelector('.receipt'));
    return document.querySelector('.receipt').innerText.replace(/\\n+/g, ' / ');
  })()`);
  await sleep(300);
  await snap("10-nota-credito");

  // 4c) La impresora se apaga: la venta se registra igual y la pantalla avisa con la opción de reintentar.
  await printer.stop();
  out.printFail = await run(`(async () => {
    __btn('Nueva venta').click();
    await new Promise((r) => setTimeout(r, 300));
    const input = document.querySelector('input[aria-label^="Buscar"]');
    __setv(input, '7461004'); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise((r) => setTimeout(r, 400));
    __btn('Cobrar').click();
    await __wait(() => document.querySelector('.modal'));
    __btn('Confirmar cobro', document.querySelector('.modal')).click();
    await __wait(() => document.querySelector('.receipt'));
    __btn('Nueva venta').click();
    await __wait(() => [...document.querySelectorAll('[role=alert]')].some((a) => /No se pudo imprimir/.test(a.innerText)), 15000);
    return [...document.querySelectorAll('[role=alert]')].map((a) => a.innerText.replace(/\\n+/g, ' ')).find((t) => /No se pudo imprimir/.test(t));
  })()`);
  await snap("10b-error-impresion");
  await printer.start();
  out.printRetry = await run(`(async () => {
    const alertEl = () => [...document.querySelectorAll('[role=alert]')].find((a) => /No se pudo imprimir/.test(a.innerText));
    [...alertEl().querySelectorAll('button')].find((b) => b.innerText.trim() === 'Reintentar').click();
    await __wait(() => !alertEl(), 15000);
    return true;
  })()`);
  // Vuelve a tener un ticket abierto para que siga el paso del cierre (que empieza con «Nueva venta»).
  await run(`(async () => {
    const input = document.querySelector('input[aria-label^="Buscar"]');
    __setv(input, '7461004'); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    __btn('Vaciar').click();
    await new Promise((r) => setTimeout(r, 200));
    window.pos.sales({ limit: 1 }).then((s) => window.pos.receipt(s[0].id)).then(() => true);
    return true;
  })()`);

  // 5) Cierre de turno: esperado = 500 + 200 (efectivo) − 118 (devuelto) = 582; se cuentan 580 → pide el motivo.
  out.close = await run(`(async () => {
    __btn('Cerrar turno').click();
    await __wait(() => document.querySelector('.modal'));
    const modal = () => document.querySelector('.modal');
    __setv(modal().querySelector('input'), '580');
    __btn('Cerrar turno', modal()).click();
    await __wait(() => /diferencia/i.test(modal().innerText));
    const asked = modal().querySelector('[role=alert]').innerText;
    __setv(modal().querySelectorAll('input')[1], 'Faltaron 2 pesos de cambio');
    __btn('Cerrar turno', modal()).click();
    await __wait(() => document.querySelector('.receipt'));
    return { asked, z: document.querySelector('.receipt').innerText.replace(/\\n+/g, ' / ') };
  })()`);
  await sleep(300);
  await snap("11-informe-z");
  await run(`(async () => {
    [...document.querySelectorAll('.modal button')].find((b) => b.innerText.trim() === 'Reimprimir').click();
    await new Promise((r) => setTimeout(r, 1200));
    return true;
  })()`);
  out.final = await run(`(async () => {
    __btn('Listo').click();
    await new Promise((r) => setTimeout(r, 300));
    __btn('Sincronizar').click();
    await __wait(() => !/por subir|Turno sin subir/.test(document.querySelector('.statuses').innerText), 15000);
    const s = await window.pos.state();
    return { pending: s.pendingSales, shiftErrors: s.shiftErrors, shift: s.shift, statuses: document.querySelector('.statuses').innerText.replace(/\\n/g, ' · ') };
  })()`);
  // 6) Bloquear y volver a entrar.
  await run(`__btn('Bloquear').click()`);
  await sleep(500);
  await snap("12-bloqueada");
  await sleep(500);
  out.receiptSigned = await run(`window.pos.sales({ limit: 50 }).then(async (rows) => {
    const done = rows.filter((r) => r.status === 'SYNCED' && r.type !== 'E34');
    const r = await window.pos.receipt(done[0].id);
    return { synced: done.length, securityCode: r.securityCode, qr: r.qr, signedAt: r.signedAt };
  })`);
  out.printJobs = printer.jobs.map(summarize);
  await printer.stop();
  return out;
}
