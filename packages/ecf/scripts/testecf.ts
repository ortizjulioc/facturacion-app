/**
 * Prototipo contra TesteCF (pre-certificación de la DGII): arma, firma y envía comprobantes de ejemplo con tu certificado
 * y muestra qué contestó la DGII. Guía completa: docs/PRUEBA-TESTECF.md
 *
 *   pnpm --filter @facturacion/ecf testecf --probe
 *   TESTECF_PASSWORD=*** pnpm --filter @facturacion/ecf testecf --p12 ruta/certificado.p12 --rnc 101000000 --dry-run
 *   TESTECF_PASSWORD=*** pnpm --filter @facturacion/ecf testecf --p12 ruta/certificado.p12 --rnc 101000000 --buyer-rnc 131000000
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadCertificate, certificateProblem, runPrototype, serviceUrls, STEPS, STEP_LABELS, type EcfEnvironment, type Step } from "../src/index";

const HELP = `Uso: testecf [opciones]

  --probe              Solo comprueba que el servicio de autenticación de la DGII responde (no necesita certificado)
  --p12 <archivo>      Certificado digital (.p12 / .pfx) con el que se firma
  --rnc <RNC>          RNC del emisor (el del titular del certificado)
  --buyer-rnc <RNC>    RNC del comprador de los comprobantes de ejemplo (por omisión, el mismo RNC)
  --buyer-name <texto> Nombre del comprador (por omisión «COMPRADOR DE PRUEBA»)
  --name <texto>       Razón social del emisor (por omisión «EMISOR DE PRUEBA»)
  --address <texto>    Dirección del emisor
  --env test|cert      Ambiente: test = pre-certificación (TesteCF, por omisión); cert = certificación (CerteCF)
  --only a,b           Pasos a correr: ${STEPS.join(", ")} (por omisión, e31,e32,e32-grande,e34)
  --expiry AAAA-MM-DD  Vencimiento de la secuencia de prueba (por omisión 2028-12-31)
  --start-e31 N        Primer número de E31 a usar (por omisión, el siguiente al de la última corrida; o 1)
  --start-e32 N        ... de E32
  --start-e34 N        ... de E34
  --out <carpeta>      Dónde guardar lo que pasó (por omisión ./testecf-out)
  --dry-run            Arma y firma todo pero no envía nada a la DGII
  --help               Esta ayuda

La contraseña del certificado va en la variable de entorno TESTECF_PASSWORD (no en la línea de comandos).`;

function parse(argv: string[]) {
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) throw new Error(`Argumento no reconocido: ${a}`);
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(key, next);
      i++;
    } else flags.set(key, true);
  }
  return flags;
}

const ENVS: Record<string, EcfEnvironment> = { test: "TEST", cert: "CERT" };

async function readState(file: string): Promise<Partial<Record<"E31" | "E32" | "E34", string>>> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return {};
  }
}

async function main() {
  const flags = parse(process.argv.slice(2));
  const str = (k: string) => (typeof flags.get(k) === "string" ? (flags.get(k) as string) : undefined);
  if (flags.has("help")) return console.log(HELP);

  const envName = (str("env") ?? "test").toLowerCase();
  const env = ENVS[envName];
  if (!env) throw new Error(`Ambiente «${envName}» no válido: usa test o cert (producción no se prueba desde aquí)`);

  if (flags.has("probe")) {
    const url = `${serviceUrls(env).authentication}/api/autenticacion/semilla`;
    console.log(`GET ${url}`);
    const res = await fetch(url, { headers: { accept: "*/*" }, signal: AbortSignal.timeout(20_000) }).catch((e: unknown) => {
      throw new Error(`No se pudo conectar: ${e instanceof Error ? e.message : String(e)}`);
    });
    const body = await res.text();
    const looksRight = /<SemillaModel[\s>]/i.test(body) && /<valor>/i.test(body);
    console.log(`HTTP ${res.status} · ${looksRight ? "devolvió una semilla: el servicio está al alcance" : "la respuesta no parece una semilla"}`);
    if (!looksRight) console.log(body.slice(0, 400));
    process.exitCode = looksRight ? 0 : 1;
    return;
  }

  const p12Path = str("p12");
  const rnc = str("rnc")?.replace(/[\s-]/g, "");
  if (!p12Path || !rnc) throw new Error("Faltan --p12 y --rnc (usa --help para ver todas las opciones)");
  const password = process.env.TESTECF_PASSWORD;
  if (!password) throw new Error("Falta la contraseña del certificado en la variable de entorno TESTECF_PASSWORD");
  if (!/^(\d{9}|\d{11})$/.test(rnc)) throw new Error("El RNC debe tener 9 dígitos (o 11 si es una cédula)");

  const cert = loadCertificate(await readFile(resolve(p12Path)), password);
  const problem = certificateProblem(cert);
  if (problem) throw new Error(problem);
  console.log(`Certificado: ${cert.subject} · vence ${cert.notAfter.toISOString().slice(0, 10)}`);

  const only = str("only")?.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const steps = (only ?? ["e31", "e32", "e32-grande", "e34"]) as Step[];
  for (const s of steps) if (!(STEPS as readonly string[]).includes(s)) throw new Error(`Paso «${s}» no válido: ${STEPS.join(", ")}`);

  const outRoot = resolve(str("out") ?? "testecf-out");
  const stateFile = join(outRoot, `estado-${env.toLowerCase()}-${rnc}.json`);
  const state = await readState(stateFile);
  const num = (flag: string, key: "E31" | "E32" | "E34") => BigInt(str(flag) ?? state[key] ?? "1");

  const dryRun = flags.has("dry-run");
  const report = await runPrototype({
    env,
    certificate: cert,
    rnc,
    legalName: str("name") ?? "EMISOR DE PRUEBA",
    address: str("address") ?? "Calle Principal 1, Santo Domingo",
    buyerRnc: (str("buyer-rnc") ?? rnc).replace(/[\s-]/g, ""),
    buyerName: str("buyer-name") ?? "COMPRADOR DE PRUEBA",
    steps,
    numbers: { E31: num("start-e31", "E31"), E32: num("start-e32", "E32"), E34: num("start-e34", "E34") },
    expiry: str("expiry") ?? "2028-12-31",
    dryRun,
    log: (line) => console.log(line),
  });

  // Todo lo que pasó, en una carpeta con la hora de la corrida.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(outRoot, `${stamp}${dryRun ? "-simulacro" : ""}`);
  await mkdir(dir, { recursive: true });
  for (const a of report.artifacts) await writeFile(join(dir, a.name), a.content, "utf8");
  await writeFile(
    join(dir, "resumen.json"),
    JSON.stringify(report.results.map(({ artifacts: _a, ...r }) => r), null, 2),
    "utf8",
  );
  if (!dryRun) {
    // Solo una corrida real gasta números: el simulacro no mueve el contador.
    await writeFile(stateFile, JSON.stringify({ E31: String(report.next.E31), E32: String(report.next.E32), E34: String(report.next.E34) }, null, 2), "utf8");
  }

  console.log("\nResumen");
  for (const r of report.results) {
    console.log(`  ${r.ok ? "✔" : "✘"} ${STEP_LABELS[r.step]}\n      ${r.encf} · ${r.status}${r.trackId ? ` · TrackId ${r.trackId}` : ""}${r.error ? ` · ${r.error}` : ""}`);
    for (const m of r.messages) console.log(`      - ${m}`);
    console.log(`      QR: ${r.qrUrl}`);
  }
  console.log(`\nArchivos guardados en ${dir}`);
  if (report.fatal) console.log(`\n${report.fatal}`);
  process.exitCode = report.fatal || report.results.some((r) => !r.ok) ? 1 : 0;
}

main().catch((e: unknown) => {
  console.error(`\n✘ ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
