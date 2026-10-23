// Genera el instalador de la caja (`pnpm --filter @facturacion/pos dist`), y firmado con `dist:signed`.
//
// La firma de código la toma electron-builder de estas variables de entorno (nunca van en un archivo del proyecto):
//   CSC_LINK           ruta al certificado .pfx/.p12 de firma de código (o su contenido en base64)
//   CSC_KEY_PASSWORD   contraseña del certificado
// Opcional:
//   POS_PUBLISHER_NAME  nombre común (CN) del certificado. Se graba en la caja instalada: la auto-actualización solo acepta
//                       instaladores firmados por ese nombre, aunque alguien tomara el servidor de versiones.
//   POS_ALLOW_UNTRUSTED=1  acepta un certificado de prueba (autofirmado) al verificar la firma.
//
// Con `--signed` (o POS_REQUIRE_SIGNING=1) no se genera nada si falta el certificado, y al terminar se verifica con Windows
// que el instalador quedó firmado: así no se entrega por error un instalador sin firma.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const requireSigned = args.includes("--signed") || process.env.POS_REQUIRE_SIGNING === "1";
const passthrough = args.filter((a) => a !== "--signed");

if (requireSigned && (!process.env.CSC_LINK || !process.env.CSC_KEY_PASSWORD)) {
  console.error("Falta el certificado de firma: define CSC_LINK (ruta al .pfx) y CSC_KEY_PASSWORD. Ver docs/CAJA-INSTALADOR.md §6.");
  process.exit(2);
}

const quote = (s) => `"${s.replaceAll('"', '\\"')}"`;
const run = (cmd) => {
  const r = spawnSync(cmd, { cwd: root, stdio: "inherit", shell: true });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

run("pnpm exec electron-vite build");
const publisher = process.env.POS_PUBLISHER_NAME ? ` ${quote(`-c.win.signtoolOptions.publisherName=${process.env.POS_PUBLISHER_NAME}`)}` : "";
run(`pnpm exec electron-builder --publish never${publisher} ${passthrough.map(quote).join(" ")}`);

// Verificación de la firma del instalador generado.
const dist = join(root, "dist");
const installer = readdirSync(dist).find((f) => /^Caja-Facturacion-Setup-.*\.exe$/.test(f));
if (!installer) {
  console.error("No se encontró el instalador en dist/.");
  process.exit(1);
}
const check = spawnSync(
  "powershell",
  ["-NoProfile", "-Command", `$s = Get-AuthenticodeSignature -LiteralPath '${join(dist, installer)}'; "$($s.Status)|$($s.SignerCertificate.Subject)"`],
  { encoding: "utf8" },
);
const [status, signer] = (check.stdout ?? "").trim().split("|");
const signed = Boolean(signer);
const trusted = status === "Valid";
console.log(`\nInstalador: dist/${installer}\nFirma: ${signed ? `${status} · ${signer}` : "SIN FIRMA (Windows avisará «editor desconocido»)"}`);
if (requireSigned && !(trusted || (signed && process.env.POS_ALLOW_UNTRUSTED === "1"))) {
  console.error("El instalador no quedó con una firma válida: no lo publiques.");
  process.exit(1);
}
