import { Prisma, tenantTransaction, type DbClient } from "@facturacion/db";
import {
  DgiiClient,
  FiscalError,
  isFiscallyValid,
  type EcfCertificate,
  type EcfEnvironment,
  type FetchLike,
  type FiscalProvider,
  type TrackResult,
} from "@facturacion/ecf";
import type { Env } from "../env";
import type { Logger } from "../logger";
import { fiscalBlock } from "./fiscal-queue";
import { loadSigner } from "./signing";

export { enqueueIfAuto, enqueueSubmission, fiscalBlock, retrySubmission } from "./fiscal-queue";

export type FiscalDeps = { env: Env; prisma: DbClient; logger: Logger; fetch?: FetchLike };

// ───────────── Reglas de la cola ─────────────

/** Esperas (segundos) entre reintentos de un envío que falló por algo temporal; la última se repite. */
export const SEND_BACKOFF_SECONDS = [30, 120, 600, 1_800, 3_600];
/** Esperas entre consultas del resultado mientras la DGII lo procesa («promedio estimado de validación: 200 ms»). */
export const POLL_BACKOFF_SECONDS = [3, 10, 30, 60, 120, 300];
/** Intentos de envío antes de rendirse y pedir revisión (≈ 17 horas con las esperas de arriba). */
export const MAX_SEND_ATTEMPTS = 20;
/** Consultas del resultado antes de rendirse (≈ 1 día). */
export const MAX_POLL_ATTEMPTS = 300;
/** Cuánto tiempo se reserva una fila mientras se procesa (si el proceso muere, otro la retoma). */
const LOCK_SECONDS = 120;

const wait = (table: number[], attempts: number) => table[Math.min(Math.max(attempts - 1, 0), table.length - 1)]!;

// ───────────── Cliente por empresa ─────────────

/** Un cliente por certificado y ambiente: así se conserva el token (dura una hora) entre envíos. */
const clients = new WeakMap<EcfCertificate, Map<EcfEnvironment, DgiiClient>>();

function clientFor(cert: EcfCertificate, env: EcfEnvironment, fetch?: FetchLike): FiscalProvider {
  let byEnv = clients.get(cert);
  if (!byEnv) clients.set(cert, (byEnv = new Map()));
  let client = byEnv.get(env);
  if (!client) byEnv.set(env, (client = new DgiiClient({ env, certificate: cert, ...(fetch ? { fetch } : {}) })));
  return client;
}

// ───────────── Trabajador ─────────────

export type ProcessSummary = { claimed: number; sent: number; accepted: number; rejected: number; retried: number; failed: number };

export type ProcessOptions = {
  now?: Date;
  limit?: number;
  /** Solo las filas de esta empresa (la ruta manual). */
  organizationId?: string;
  /** Solo este comprobante, sin esperar a su hora (el botón «Consultar ahora»). */
  documentId?: string;
};

const iso = (d: Date) => d.toISOString();
const later = (now: Date, seconds: number) => new Date(now.getTime() + seconds * 1000);

/** Reserva las filas que ya les toca, de todas las empresas, para que dos procesos no envíen lo mismo. */
async function claim(prisma: DbClient, now: Date, o: ProcessOptions): Promise<{ id: string; organizationId: string }[]> {
  const until = later(now, LOCK_SECONDS);
  const due = o.documentId
    ? Prisma.sql`"documentId" = ${o.documentId}::uuid`
    : Prisma.sql`"nextAttemptAt" <= ${iso(now)}::timestamp`;
  const org = o.organizationId ? Prisma.sql`AND "organizationId" = ${o.organizationId}` : Prisma.empty;
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.system', 'fiscal-worker', TRUE)`;
    return tx.$queryRaw<{ id: string; organizationId: string }[]>`
      UPDATE "fiscal_submission" SET "lockedUntil" = ${iso(until)}::timestamp, "updatedAt" = now()
      WHERE "id" IN (
        SELECT "id" FROM "fiscal_submission"
        WHERE "state" IN ('PENDING'::"FiscalState", 'SENT'::"FiscalState")
          AND ${due} ${org}
          AND ("lockedUntil" IS NULL OR "lockedUntil" < ${iso(now)}::timestamp)
        ORDER BY "nextAttemptAt"
        LIMIT ${o.limit ?? 20}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING "id", "organizationId"`;
  });
}

/**
 * Procesa lo que toca de la cola de envío: manda a la DGII los comprobantes pendientes y consulta el resultado de los
 * enviados. Se llama cada pocos segundos desde el servidor; nunca lanza (cada fallo queda anotado en su fila).
 */
export async function processDue(deps: FiscalDeps, o: ProcessOptions = {}): Promise<ProcessSummary> {
  const now = o.now ?? new Date();
  const summary: ProcessSummary = { claimed: 0, sent: 0, accepted: 0, rejected: 0, retried: 0, failed: 0 };
  const rows = await claim(deps.prisma, now, o);
  summary.claimed = rows.length;
  for (const row of rows) {
    try {
      const outcome = await processOne(deps, row.organizationId, row.id, now);
      summary[outcome]++;
    } catch (e) {
      // Un error nuestro (no de la DGII): se reintenta en un minuto y se deja el motivo.
      deps.logger.error({ err: e, submissionId: row.id }, "fallo procesando un envío fiscal");
      await tenantTransaction(deps.prisma, row.organizationId, (tx) =>
        tx.fiscalSubmission.update({
          where: { id: row.id },
          data: { lockedUntil: null, nextAttemptAt: later(now, 60), lastError: e instanceof Error ? e.message : "Error interno" },
        }),
      ).catch(() => undefined);
      summary.retried++;
    }
  }
  return summary;
}

type Outcome = "sent" | "accepted" | "rejected" | "retried" | "failed";

async function processOne(deps: FiscalDeps, organizationId: string, id: string, now: Date): Promise<Outcome> {
  const loaded = await tenantTransaction(deps.prisma, organizationId, async (tx) => {
    const sub = await tx.fiscalSubmission.findFirst({ where: { id }, include: { document: true } });
    const profile = await tx.companyProfile.findFirst({ select: { rnc: true, environment: true } });
    const cert = sub ? await loadSigner(tx, deps.env, organizationId) : null;
    return { sub, profile, cert };
  });
  const { sub, profile, cert } = loaded;
  if (!sub || (sub.state !== "PENDING" && sub.state !== "SENT")) return "retried";

  const fail = (message: string, outcome: Outcome = "failed") =>
    save(deps, organizationId, sub.id, sub.documentId, { state: "FAILED", lastError: message, lockedUntil: null, finishedAt: now, attempts: sub.attempts + 1 }, null).then(() => outcome);

  if (!profile) return fail("Faltan los datos fiscales de la empresa");
  if (!cert) return fail("La empresa no tiene un certificado digital cargado");
  const block = fiscalBlock({ ...sub.document });
  if (block) return fail(block);
  const provider = clientFor(cert, profile.environment, deps.fetch);
  const attempts = sub.attempts + 1;

  try {
    if (sub.state === "PENDING") {
      const { trackId } = await provider.submit({ xml: sub.document.ecfXml!, rnc: profile.rnc, encf: sub.document.encf! });
      await save(deps, organizationId, sub.id, sub.documentId, {
        state: "SENT", trackId, attempts: 0, sentAt: now, lastError: null, lockedUntil: null, nextAttemptAt: later(now, POLL_BACKOFF_SECONDS[0]!),
      }, "SENT");
      return "sent";
    }

    const result = await provider.result(sub.trackId!);
    return await recordResult(deps, organizationId, sub, result, attempts, now);
  } catch (e) {
    if (!(e instanceof FiscalError)) throw e;
    const polling = sub.state === "SENT";
    const max = polling ? MAX_POLL_ATTEMPTS : MAX_SEND_ATTEMPTS;
    if (!e.retryable || attempts >= max) {
      return fail(e.retryable ? `Se agotaron los intentos: ${e.message}` : e.message);
    }
    await save(deps, organizationId, sub.id, sub.documentId, {
      attempts, lastError: e.message, lockedUntil: null, nextAttemptAt: later(now, wait(polling ? POLL_BACKOFF_SECONDS : SEND_BACKOFF_SECONDS, attempts)),
    }, null);
    return "retried";
  }
}

async function recordResult(
  deps: FiscalDeps,
  organizationId: string,
  sub: { id: string; documentId: string },
  r: TrackResult,
  attempts: number,
  now: Date,
): Promise<Outcome> {
  const info = { dgiiCode: r.code, dgiiStatus: r.statusText || r.status, messages: r.messages, sequenceUsed: r.sequenceUsed, receivedAt: r.receivedAt };
  if (r.status === "IN_PROCESS" || r.status === "NOT_FOUND") {
    // Un TrackId que la DGII no encuentra tras varias consultas es un problema, no una espera.
    if (r.status === "NOT_FOUND" && attempts >= 10) {
      await save(deps, organizationId, sub.id, sub.documentId, { ...info, state: "FAILED", lastError: "La DGII no encuentra el TrackId del envío", lockedUntil: null, finishedAt: now, attempts }, null);
      return "failed";
    }
    if (attempts >= MAX_POLL_ATTEMPTS) {
      await save(deps, organizationId, sub.id, sub.documentId, { ...info, state: "FAILED", lastError: "La DGII sigue sin dar el resultado de la validación", lockedUntil: null, finishedAt: now, attempts }, null);
      return "failed";
    }
    await save(deps, organizationId, sub.id, sub.documentId, { ...info, attempts, lastError: null, lockedUntil: null, nextAttemptAt: later(now, wait(POLL_BACKOFF_SECONDS, attempts)) }, null);
    return "retried";
  }
  const docStatus = r.status === "ACCEPTED" ? "ACCEPTED" : r.status === "ACCEPTED_CONDITIONAL" ? "ACCEPTED_CONDITIONAL" : "REJECTED";
  await save(deps, organizationId, sub.id, sub.documentId, { ...info, state: "DONE", attempts, lastError: null, lockedUntil: null, finishedAt: now }, docStatus);
  return isFiscallyValid(r.status) ? "accepted" : "rejected";
}

type SubmissionPatch = Prisma.FiscalSubmissionUncheckedUpdateInput;

/** Guarda el avance de un envío y, si cambia, el estado fiscal del comprobante, en la misma transacción. */
async function save(
  deps: FiscalDeps,
  organizationId: string,
  id: string,
  documentId: string,
  patch: SubmissionPatch,
  docStatus: "SENT" | "ACCEPTED" | "ACCEPTED_CONDITIONAL" | "REJECTED" | null,
) {
  await tenantTransaction(deps.prisma, organizationId, async (tx) => {
    await tx.fiscalSubmission.update({ where: { id }, data: patch });
    if (docStatus) await tx.document.update({ where: { id: documentId }, data: { status: docStatus } });
  });
}

