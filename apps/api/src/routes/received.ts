import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { fromCents } from "@facturacion/core";
import type { Prisma } from "@facturacion/db";
import { decide, formatDmyUtc, ReceiverError, resendApproval } from "../lib/receiver";
import { listQuery, pageOf, uuidParam } from "../lib/schemas";
import { zv } from "../lib/validator";
import { requireRole } from "../middleware/tenant";
import type { AppEnv } from "../types";

type Row = Prisma.ReceivedDocumentGetPayload<object>;

export const receivedDto = (r: Row) => ({
  id: r.id,
  emitterRnc: r.emitterRnc,
  emitterName: r.emitterName,
  ecfType: r.ecfType,
  encf: r.encf,
  issuedOn: r.issuedOn.toISOString().slice(0, 10),
  issuedOnText: formatDmyUtc(r.issuedOn),
  total: fromCents(r.total),
  totalItbis: fromCents(r.totalItbis),
  signatureValid: r.signatureValid,
  securityCode: r.securityCode,
  signedAtText: r.signedAtText,
  receivedAt: r.receivedAt,
  /** La factura de consumo no lleva aprobación comercial. */
  needsApproval: r.ecfType !== "32",
  approved: r.approved,
  approvalReason: r.approvalReason,
  decidedAt: r.decidedAt,
  approvalState: r.approvalState,
  approvalAttempts: r.approvalAttempts,
  approvalNextAt: r.approvalNextAt,
  peerSentAt: r.peerSentAt,
  peerError: r.peerError,
  dgiiSentAt: r.dgiiSentAt,
  dgiiError: r.dgiiError,
});

const query = listQuery.omit({ active: true }).extend({
  /** pending = sin decidir; approved / rejected = decididos. */
  decision: z.enum(["pending", "approved", "rejected"]).optional(),
});

const body = z.object({ approved: z.boolean(), reason: z.string().trim().max(250).nullish() });

const fail = (e: unknown): never => {
  if (e instanceof ReceiverError) throw new HTTPException(e.status, { message: e.message });
  throw e;
};

/** e-CF que nos enviaron nuestros proveedores y la respuesta comercial que damos. */
export const received = new Hono<AppEnv>()
  .get("/", zv("query", query), async (c) => {
    const { q, page, pageSize, decision } = c.req.valid("query");
    const where: Prisma.ReceivedDocumentWhereInput = {
      ...(q
        ? { OR: [{ encf: { contains: q, mode: "insensitive" } }, { emitterRnc: { contains: q } }, { emitterName: { contains: q, mode: "insensitive" } }] }
        : {}),
      ...(decision === "pending"
        ? { approved: null, ecfType: { not: "32" } }
        : decision === "approved"
          ? { approved: true }
          : decision === "rejected"
            ? { approved: false }
            : {}),
    };
    const db = c.get("db");
    const [rows, total] = await Promise.all([
      db.receivedDocument.findMany({ where, orderBy: { receivedAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize }),
      db.receivedDocument.count({ where }),
    ]);
    return c.json(pageOf(rows.map(receivedDto), total, page, pageSize));
  })
  .get("/:id", zv("param", uuidParam), async (c) => {
    const row = await c.get("db").receivedDocument.findFirst({ where: { id: c.req.valid("param").id } });
    if (!row) throw new HTTPException(404, { message: "Comprobante recibido no encontrado" });
    return c.json({ data: receivedDto(row) });
  })
  // El XML tal como llegó (para conservarlo o importarlo).
  .get("/:id/xml", zv("param", uuidParam), async (c) => {
    const row = await c.get("db").receivedDocument.findFirst({
      where: { id: c.req.valid("param").id },
      select: { xml: true, encf: true, emitterRnc: true },
    });
    if (!row) throw new HTTPException(404, { message: "Comprobante recibido no encontrado" });
    return c.body(row.xml, 200, {
      "content-type": "application/xml; charset=utf-8",
      "content-disposition": `attachment; filename="${row.emitterRnc}${row.encf}.xml"`,
    });
  })
  // Aprueba o rechaza comercialmente: se firma la respuesta y se entrega al emisor y a la DGII.
  .post("/:id/decision", requireRole("owner", "admin"), zv("param", uuidParam), zv("json", body), async (c) => {
    const { id } = c.req.valid("param");
    const input = c.req.valid("json");
    const deps = c.get("deps");
    try {
      const row = await decide(
        { env: deps.env, prisma: deps.prisma, logger: deps.logger, ...(deps.fiscalFetch ? { fetch: deps.fiscalFetch } : {}) },
        c.get("organizationId"),
        id,
        { approved: input.approved, reason: input.reason ?? null, userId: c.get("user").id },
      );
      return c.json({ data: receivedDto(row!) });
    } catch (e) {
      return fail(e);
    }
  })
  // Reintenta entregar una respuesta cuya entrega falló.
  .post("/:id/resend", requireRole("owner", "admin"), zv("param", uuidParam), async (c) => {
    const deps = c.get("deps");
    try {
      const row = await resendApproval(
        { env: deps.env, prisma: deps.prisma, logger: deps.logger, ...(deps.fiscalFetch ? { fetch: deps.fiscalFetch } : {}) },
        c.get("organizationId"),
        c.req.valid("param").id,
      );
      return c.json({ data: receivedDto(row!) });
    } catch (e) {
      return fail(e);
    }
  });
