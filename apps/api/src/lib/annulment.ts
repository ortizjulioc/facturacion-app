import { HTTPException } from "hono/http-exception";
import { Prisma, tenantTransaction } from "@facturacion/db";
import { buildAnecf, EcfError, FiscalError, signReply, type AnnulmentResult } from "@facturacion/ecf";
import { auditRow } from "./audit";
import { clientFor, type FiscalDeps } from "./fiscal";
import { loadSigner } from "./signing";

const unprocessable = (message: string) => new HTTPException(422, { message });

/** Una anulación sin respuesta tras este tiempo se puede cancelar a mano (el proceso se cayó a mitad de camino). */
export const STALE_AFTER_MS = 2 * 60_000;

export type AnnulInput = { sequenceId: string; from?: bigint | null; to?: bigint | null };

/**
 * Anula ante la DGII números de e-NCF SIN USAR de una secuencia (archivo ANECF) y los quita de la secuencia.
 *
 * En tres pasos, para no perder ni duplicar números: (1) se bloquea la secuencia, se valida el rango y se **desactiva**
 * mientras dura la anulación (nadie saca números de ahí) dejando constancia en estado PENDING; (2) se envía a la DGII,
 * fuera de toda transacción; (3) si la DGII la acepta, se aplica a la secuencia —se agota el rango o se acorta su final—
 * y, pase lo que pase, se reactiva como estaba. Solo se anula el **inicio** o el **final** de lo que queda sin usar
 * (nunca el medio, que dejaría un hueco con números usados a los lados), y no los bloques de una caja sin conexión.
 */
export async function annulUnused(deps: FiscalDeps, organizationId: string, userId: string, input: AnnulInput, now: Date = new Date()) {
  // ── 1. Validar y reservar ──
  const reserved = await tenantTransaction(deps.prisma, organizationId, async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "sequence" WHERE "id" = ${input.sequenceId}::uuid FOR UPDATE`;
    const seq = await tx.sequence.findFirst({ where: { id: input.sequenceId } });
    if (!seq) throw new HTTPException(404, { message: "Secuencia no encontrada" });
    if (seq.offline) throw unprocessable("Es un bloque entregado a una caja sin conexión: los números sin usar vuelven a la nube al sincronizarla; no se anulan desde aquí");
    if (seq.nextNumber > seq.toNumber) throw unprocessable("A esta secuencia no le quedan números sin usar");

    const from = input.from ?? seq.nextNumber;
    const to = input.to ?? seq.toNumber;
    if (from < seq.nextNumber || to > seq.toNumber || to < from) {
      throw unprocessable(`El rango debe estar entre los números sin usar de la secuencia (${seq.nextNumber}–${seq.toNumber})`);
    }
    if (from !== seq.nextNumber && to !== seq.toNumber) {
      throw unprocessable("Solo se puede anular el inicio o el final de lo que queda sin usar de la secuencia, no un tramo del medio");
    }
    const pending = await tx.sequenceAnnulment.findFirst({ where: { sequenceId: seq.id, state: "PENDING" }, select: { id: true } });
    if (pending) throw new HTTPException(409, { message: "Esta secuencia ya tiene una anulación en curso" });

    const [profile, cert] = [await tx.companyProfile.findFirst({ select: { rnc: true, environment: true } }), await loadSigner(tx, deps.env, organizationId)];
    if (!profile || !cert) throw unprocessable("Para anular números necesitas los datos fiscales y el certificado digital de la empresa");

    let xml: string;
    try {
      xml = signReply(buildAnecf({ rnc: profile.rnc, at: now, lines: [{ type: seq.ecfType, ranges: [{ from, to }] }] }), cert, "ANECF", now);
    } catch (e) {
      if (e instanceof EcfError) throw unprocessable(e.message);
      throw e;
    }
    await tx.sequence.update({ where: { id: seq.id }, data: { active: false } });
    const row = await tx.sequenceAnnulment.create({
      data: { organizationId, sequenceId: seq.id, ecfType: seq.ecfType, fromNumber: from, toNumber: to, count: Number(to - from + 1n), wasActive: seq.active, xml, requestedById: userId, createdAt: now },
    });
    await tx.auditLog.create({ data: auditRow({ organizationId, userId }, "sequence.annul_request", "sequence_annulment", row.id, { ecfType: seq.ecfType, from: Number(from), to: Number(to) }) });
    return { row, seq, profile, cert, xml };
  });

  // ── 2. Enviar a la DGII ──
  const { row, profile, cert } = reserved;
  let result: AnnulmentResult | null = null;
  let error: string | null = null;
  let messages: string[] = [];
  try {
    result = await clientFor(cert, profile.environment, deps.fetch).annulRanges({ xml: reserved.xml, rnc: profile.rnc, firstEncf: encfOf(row.ecfType, row.fromNumber) });
    messages = result.messages;
    if (!result.annulled) error = result.messages.join(" · ") || "La DGII no anuló todos los números";
  } catch (e) {
    if (!(e instanceof FiscalError)) throw e;
    error = e.retryable ? `No se pudo confirmar con la DGII (${e.message}). Revisa en la Oficina Virtual si los números quedaron anulados antes de reintentar` : e.message;
  }

  // ── 3. Aplicar o soltar ──
  return tenantTransaction(deps.prisma, organizationId, async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "sequence" WHERE "id" = ${row.sequenceId}::uuid FOR UPDATE`;
    const seq = await tx.sequence.findFirstOrThrow({ where: { id: row.sequenceId! } });
    const ok = result?.annulled === true;
    const data: Prisma.SequenceUncheckedUpdateInput = { active: row.wasActive };
    if (ok) {
      if (row.fromNumber === seq.nextNumber && row.toNumber === seq.toNumber) data.nextNumber = seq.toNumber + 1n; // se agota
      else if (row.toNumber === seq.toNumber) data.toNumber = row.fromNumber - 1n; // se acorta el final
      else data.nextNumber = row.toNumber + 1n; // se salta el inicio
    }
    await tx.sequence.update({ where: { id: seq.id }, data });
    const done = await tx.sequenceAnnulment.update({
      where: { id: row.id },
      data: { state: ok ? "DONE" : "FAILED", responseCode: result?.code ?? null, responseMessages: messages, error: ok ? null : error, completedAt: new Date() },
    });
    await tx.auditLog.create({
      data: auditRow({ organizationId, userId }, ok ? "sequence.annul" : "sequence.annul_failed", "sequence_annulment", row.id, { count: row.count, ...(ok ? {} : { error }) }),
    });
    return done;
  });
}

/** Cancela una anulación que se quedó sin respuesta (el proceso se cayó): deja la secuencia como estaba. */
export async function cancelStale(deps: FiscalDeps, organizationId: string, userId: string, id: string, now: Date = new Date()) {
  return tenantTransaction(deps.prisma, organizationId, async (tx) => {
    const row = await tx.sequenceAnnulment.findFirst({ where: { id } });
    if (!row) throw new HTTPException(404, { message: "Anulación no encontrada" });
    if (row.state !== "PENDING") throw new HTTPException(409, { message: "Esta anulación ya terminó" });
    if (now.getTime() - row.createdAt.getTime() < STALE_AFTER_MS) throw new HTTPException(409, { message: "La anulación todavía está en curso: espera un par de minutos" });
    if (row.sequenceId) await tx.sequence.update({ where: { id: row.sequenceId }, data: { active: row.wasActive } });
    const done = await tx.sequenceAnnulment.update({
      where: { id },
      data: { state: "FAILED", error: "Se canceló: no hubo respuesta. Revisa en la Oficina Virtual de la DGII si los números quedaron anulados", completedAt: now },
    });
    await tx.auditLog.create({ data: auditRow({ organizationId, userId }, "sequence.annul_cancel", "sequence_annulment", id) });
    return done;
  });
}

const encfOf = (type: string, n: bigint) => `E${type.slice(1)}${String(n).padStart(10, "0")}`;
