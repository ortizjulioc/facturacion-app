import { Hono } from "hono";
import { MAX_SEND_ATTEMPTS, processDue } from "../lib/fiscal";
import { requireRole } from "../middleware/tenant";
import type { AppEnv } from "../types";

/** La DGII exige enviar en 72 horas lo emitido sin conexión (contingencia); se avisa con 24 horas de margen. */
export const OVERDUE_AFTER_HOURS = 48;

/** Cola de envío a la DGII: resumen para el panel y procesamiento manual. */
export const fiscal = new Hono<AppEnv>()
  // Cuántos comprobantes hay en cada estado y los que necesitan atención: fallidos, rechazados y atrasados.
  .get("/queue", requireRole("owner", "admin"), async (c) => {
    const db = c.get("db");
    const overdueSince = new Date(Date.now() - OVERDUE_AFTER_HOURS * 3_600_000);
    const doc = { select: { encf: true, type: true, issuedAt: true } } as const;
    const [counts, failed, rejected, overdue] = await Promise.all([
      db.fiscalSubmission.groupBy({ by: ["state"], _count: { _all: true } }),
      db.fiscalSubmission.findMany({
        where: { state: "FAILED" },
        orderBy: { updatedAt: "desc" },
        take: 50,
        select: { documentId: true, lastError: true, attempts: true, updatedAt: true, document: doc },
      }),
      // Rechazados por la DGII: hay que sustituirlos por otro comprobante.
      db.fiscalSubmission.findMany({
        where: { state: "DONE", document: { status: "REJECTED" } },
        orderBy: { finishedAt: "desc" },
        take: 50,
        select: { documentId: true, lastError: true, messages: true, sequenceUsed: true, finishedAt: true, document: doc },
      }),
      // Sin respuesta definitiva cerca del plazo de 72 horas, o muchos intentos sin poder enviar (DGII caída, sin red…).
      db.fiscalSubmission.findMany({
        where: {
          state: { in: ["PENDING", "SENT"] },
          OR: [{ document: { issuedAt: { lt: overdueSince } } }, { attempts: { gte: MAX_SEND_ATTEMPTS } }],
        },
        orderBy: { createdAt: "asc" },
        take: 50,
        select: { documentId: true, state: true, lastError: true, attempts: true, document: doc },
      }),
    ]);
    const byState = { PENDING: 0, SENT: 0, DONE: 0, FAILED: 0 };
    for (const row of counts) byState[row.state] = row._count._all;
    const messages = (m: unknown) => (Array.isArray(m) ? (m as { text?: string }[]).map((x) => x.text ?? "").filter(Boolean) : []);
    return c.json({
      data: {
        ...byState,
        failed: failed.map((f) => ({ documentId: f.documentId, encf: f.document.encf, type: f.document.type, error: f.lastError, attempts: f.attempts, at: f.updatedAt })),
        rejected: rejected.map((r) => ({
          documentId: r.documentId,
          encf: r.document.encf,
          type: r.document.type,
          messages: messages(r.messages).length ? messages(r.messages) : r.lastError ? [r.lastError] : [],
          sequenceUsed: r.sequenceUsed,
          at: r.finishedAt,
        })),
        overdue: overdue.map((o) => ({
          documentId: o.documentId,
          encf: o.document.encf,
          type: o.document.type,
          state: o.state,
          error: o.lastError,
          attempts: o.attempts,
          issuedAt: o.document.issuedAt,
        })),
      },
    });
  })
  // Procesa ahora lo que ya toca de esta empresa (el trabajador lo hace solo cada pocos segundos).
  .post("/process", requireRole("owner", "admin"), async (c) => {
    const deps = c.get("deps");
    const summary = await processDue(
      { env: deps.env, prisma: deps.prisma, logger: deps.logger, ...(deps.fiscalFetch ? { fetch: deps.fiscalFetch } : {}) },
      { organizationId: c.get("organizationId") },
    );
    return c.json({ data: summary });
  });
