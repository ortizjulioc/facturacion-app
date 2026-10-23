import { toCents, toMilli, type AnyEcfType } from "@facturacion/core";
import { DgiiClient, type FetchLike } from "./dgii";
import { FiscalError, isFinalStatus, type FiscalMessage, type FiscalProvider, type FiscalStatus } from "./provider";
import { stampUrl } from "./qr";
import { signEcf, signRfce, verifyEcfSignature, type EcfCertificate } from "./sign";
import { EcfError, type EcfEnvironment, type EcfInput, type EcfReference } from "./types";
import { buildEcf, buildRfce } from "./xml";

/**
 * Prototipo contra los ambientes de prueba de la DGII (TesteCF / CerteCF): arma, firma y envía comprobantes de ejemplo,
 * consulta su resultado y devuelve todo lo que pasó para poder revisarlo. No toca la base de datos ni la aplicación:
 * sirve para comprobar el certificado, las rutas y el formato con la DGII de verdad antes de emitir desde el sistema.
 */

export const STEPS = ["e31", "e32", "e32-grande", "e34"] as const;
export type Step = (typeof STEPS)[number];

export const STEP_LABELS: Record<Step, string> = {
  e31: "E31 · factura de crédito fiscal",
  e32: "E32 · factura de consumo menor a RD$250,000 (resumen RFCE)",
  "e32-grande": "E32 · factura de consumo desde RD$250,000 (e-CF completo)",
  e34: "E34 · nota de crédito sobre el E31",
};

export type PrototypeOptions = {
  env: EcfEnvironment;
  certificate: EcfCertificate;
  /** RNC del emisor: el del titular del certificado. */
  rnc: string;
  legalName: string;
  address: string;
  /** El comprador de los comprobantes (el E31 y el E32 grande lo exigen). */
  buyerRnc: string;
  buyerName: string;
  steps: Step[];
  /** Primer número a usar de cada tipo (la DGII no deja repetir ni saltar para atrás). */
  numbers: { E31: bigint; E32: bigint; E34: bigint };
  /** Vencimiento de la secuencia de prueba, «AAAA-MM-DD». */
  expiry: string;
  /** Armar y firmar sin enviar nada. */
  dryRun: boolean;
  fetch?: FetchLike;
  now?: () => Date;
  /** Espera entre consultas del resultado (ms) y cuántas veces consultar. */
  pollMs?: number;
  maxPolls?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
};

export type Artifact = { name: string; content: string };

export type StepResult = {
  step: Step;
  encf: string;
  /** El comprobante quedó aceptado (o, en simulacro, se armó y la firma verifica). */
  ok: boolean;
  /** «DRY_RUN», un estado de la DGII o «ERROR». */
  status: string;
  messages: string[];
  trackId: string | null;
  securityCode: string;
  qrUrl: string;
  /** El e-NCF se gastó (hay que seguir con el siguiente aunque falle). */
  numberUsed: boolean;
  error: string | null;
  artifacts: Artifact[];
};

export type PrototypeReport = {
  results: StepResult[];
  /** Siguiente número libre de cada tipo después de esta corrida. */
  next: { E31: bigint; E32: bigint; E34: bigint };
  /** Archivos de la corrida (XML enviados y respuestas), para guardarlos. */
  artifacts: Artifact[];
  authenticated: boolean;
  fatal: string | null;
};

const encfOf = (type: AnyEcfType, n: bigint) => `E${type.slice(1)}${String(n).padStart(10, "0")}`;
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const FINAL_OK: FiscalStatus[] = ["ACCEPTED", "ACCEPTED_CONDITIONAL"];

/** Corre los pasos pedidos, en orden. Nunca lanza: todo fallo queda en el informe. */
export async function runPrototype(o: PrototypeOptions): Promise<PrototypeReport> {
  const log = o.log ?? (() => undefined);
  const now = o.now ?? (() => new Date());
  const sleep = o.sleep ?? defaultSleep;
  const next = { ...o.numbers };
  const report: PrototypeReport = { results: [], next, artifacts: [], authenticated: false, fatal: null };

  const seller = { rnc: o.rnc, legalName: o.legalName, address: o.address };
  const buyer = { docType: "RNC" as const, docNumber: o.buyerRnc, name: o.buyerName };
  const provider: FiscalProvider | null = o.dryRun ? null : new DgiiClient({ env: o.env, certificate: o.certificate, ...(o.fetch ? { fetch: o.fetch } : {}), now });

  // Autenticarse primero: si falla (certificado, ambiente, red) no tiene sentido seguir y el motivo es claro.
  if (provider instanceof DgiiClient) {
    try {
      await provider.authenticate();
      report.authenticated = true;
      log("✔ Autenticación: la DGII entregó un token");
    } catch (e) {
      report.fatal = `No se pudo autenticar con la DGII: ${e instanceof Error ? e.message : String(e)}`;
      log(`✘ ${report.fatal}`);
      return report;
    }
  }

  let e31: { encf: string; issuedAt: Date } | null = null;

  for (const step of o.steps) {
    const type: AnyEcfType = step === "e34" ? "E34" : step === "e31" ? "E31" : "E32";
    const number = next[type];
    const encf = encfOf(type, number);
    const at = now();
    const files: Artifact[] = [];
    const result: StepResult = { step, encf, ok: false, status: "ERROR", messages: [], trackId: null, securityCode: "", qrUrl: "", numberUsed: false, error: null, artifacts: files };
    report.results.push(result);
    log(`→ ${STEP_LABELS[step]} · ${encf}`);

    try {
      let reference: EcfReference | null = null;
      if (step === "e34") {
        if (!e31) throw new EcfError("La nota de crédito necesita un E31 aceptado: incluye el paso e31 antes");
        reference = { encf: e31.encf, issuedAt: e31.issuedAt, code: 3, reason: "Prueba: devolución parcial" };
      }
      const input: EcfInput = {
        type,
        encf,
        issuedAt: at,
        seller,
        buyer: step === "e32" ? null : buyer,
        sequenceExpiry: type === "E31" ? o.expiry : null,
        lines:
          step === "e32-grande"
            ? [{ name: "Equipo de prueba", quantity: toMilli("1"), unitPrice: toCents("250000.00"), tax: "ITBIS18" }]
            : step === "e34"
              ? [{ name: "Producto de prueba", quantity: toMilli("1"), unitPrice: toCents("50.00"), tax: "ITBIS18" }]
              : [
                  { name: "Producto de prueba", quantity: toMilli("1"), unitPrice: toCents("100.00"), tax: "ITBIS18", code: "PRUEBA-01" },
                  ...(step === "e32" ? [{ name: "Producto exento de prueba", quantity: toMilli("2"), unitPrice: toCents("25.00"), tax: "EXENTO" as const }] : []),
                ],
        payments: [{ method: step === "e32-grande" ? "TRANSFER" : "CASH", amount: 0n }],
        reference,
      };
      // Los pagos deben sumar el total: se arma una vez para saber el total y se vuelve a armar con el pago correcto.
      const total = buildEcf(input).amounts.total;
      input.payments = [{ method: input.payments![0]!.method, amount: total }];
      const built = buildEcf(input);
      const signed = signEcf(built.xml, o.certificate, at);
      if (!verifyEcfSignature(signed.xml)) throw new EcfError("La firma que se acaba de hacer no verifica (¿certificado dañado?)");
      result.securityCode = signed.securityCode;
      result.qrUrl = stampUrl({
        env: o.env,
        type,
        sellerRnc: o.rnc,
        buyerRnc: input.buyer ? o.buyerRnc : null,
        encf,
        issuedAt: at,
        total: built.amounts.total,
        signedAt: signed.signedAt,
        securityCode: signed.securityCode,
      });
      files.push({ name: `${o.rnc}${encf}.xml`, content: signed.xml });

      // La factura de consumo menor a RD$250,000 no va completa: se manda su resumen.
      const summary = step === "e32" ? signRfce(buildRfce(input, signed.securityCode).xml, o.certificate, at) : null;
      if (summary) files.push({ name: `${o.rnc}${encf}.RFCE.xml`, content: summary });

      if (!provider) {
        Object.assign(result, { ok: true, status: "DRY_RUN" });
        if (step === "e31") e31 = { encf, issuedAt: at }; // la nota de crédito del simulacro se arma sobre este E31
        continue;
      }

      result.numberUsed = true; // desde que se envía, la DGII puede dar el número por usado
      let status: FiscalStatus;
      let messages: FiscalMessage[] = [];
      if (summary) {
        const r = await provider.submitSummary({ xml: summary, rnc: o.rnc, encf });
        status = r.status;
        messages = r.messages;
        files.push({ name: `${encf}.respuesta.json`, content: JSON.stringify(r, null, 2) });
        // Un resumen se contesta en el acto; si no dio un estado final, se consulta.
        for (let i = 0; !isFinalStatus(status) || status === "NOT_FOUND"; i++) {
          if (i >= (o.maxPolls ?? 20)) break;
          await sleep(o.pollMs ?? 3000);
          const q = await provider.summaryResult(o.rnc, encf, signed.securityCode);
          status = q.status;
          messages = q.messages;
          if (status !== "NOT_FOUND" && isFinalStatus(status)) break;
        }
      } else {
        const sent = await provider.submit({ xml: signed.xml, rnc: o.rnc, encf });
        result.trackId = sent.trackId;
        log(`   TrackId ${sent.trackId}`);
        status = "IN_PROCESS";
        for (let i = 0; i < (o.maxPolls ?? 20); i++) {
          await sleep(o.pollMs ?? 3000);
          const r = await provider.result(sent.trackId);
          status = r.status;
          messages = r.messages;
          files.push({ name: `${encf}.resultado-${i + 1}.json`, content: JSON.stringify(r, null, 2) });
          if (isFinalStatus(status) && status !== "NOT_FOUND") break;
        }
      }
      result.status = status;
      result.messages = messages.map((m) => (m.code ? `${m.code}: ${m.text}` : m.text));
      result.ok = FINAL_OK.includes(status);
      if (!isFinalStatus(status)) result.error = "La DGII sigue procesándolo: consulta el TrackId más tarde";
      if (step === "e31" && result.ok) e31 = { encf, issuedAt: at };
    } catch (e) {
      result.error = e instanceof FiscalError || e instanceof EcfError || e instanceof Error ? e.message : String(e);
      if (e instanceof FiscalError && e.kind === "auth") result.error += " (¿el certificado está autorizado en este ambiente?)";
    } finally {
      // Dry-run o no, el siguiente paso usa el siguiente número: nunca se repite uno ya enviado.
      next[type] = number + 1n;
      log(`   ${result.ok ? "✔" : "✘"} ${result.status}${result.error ? ` · ${result.error}` : ""}${result.messages.length ? ` · ${result.messages.join(" · ")}` : ""}`);
    }
  }

  report.artifacts = report.results.flatMap((r) => r.artifacts);
  return report;
}
