import { Hono } from "hono";
import { processDue } from "../lib/fiscal";
import { requireRole } from "../middleware/tenant";
import type { AppEnv } from "../types";

/** Cola de envío a la DGII: resumen para el panel y procesamiento manual. */
export const fiscal = new Hono<AppEnv>()
  // Cuántos comprobantes hay en cada estado y los que necesitan revisión.
  .get("/queue", requireRole("owner", "admin"), async (c) => {
    const db = c.get("db");
    const [counts, failed] = await Promise.all([
      db.fiscalSubmission.groupBy({ by: ["state"], _count: { _all: true } }),
      db.fiscalSubmission.findMany({
        where: { state: "FAILED" },
        orderBy: { updatedAt: "desc" },
        take: 50,
        select: { documentId: true, lastError: true, attempts: true, updatedAt: true, document: { select: { encf: true, type: true } } },
      }),
    ]);
    const byState = { PENDING: 0, SENT: 0, DONE: 0, FAILED: 0 };
    for (const row of counts) byState[row.state] = row._count._all;
    return c.json({
      data: {
        ...byState,
        failed: failed.map((f) => ({ documentId: f.documentId, encf: f.document.encf, type: f.document.type, error: f.lastError, attempts: f.attempts, at: f.updatedAt })),
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
