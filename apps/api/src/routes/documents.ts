import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { ECF_TYPES } from "@facturacion/core";
import type { Prisma } from "@facturacion/db";
import { auditEntry } from "../lib/audit";
import {
  buildDraft,
  documentDto,
  documentInput,
  documentSummaryDto,
  FULL,
} from "../lib/documents";
import { issueDocument } from "../lib/issue";
import { enqueueIfAuto, enqueueSubmission, fiscalBlock, processDue, retrySubmission } from "../lib/fiscal";
import { signIssued } from "../lib/signing";
import { requireRole } from "../middleware/tenant";
import { listQuery, pageOf, uuidParam } from "../lib/schemas";
import { zv } from "../lib/validator";
import type { AppEnv } from "../types";

const documentsQuery = listQuery.omit({ active: true }).extend({
  type: z.enum(ECF_TYPES).optional(),
  status: z
    .enum([
      "DRAFT",
      "ISSUED",
      "SIGNED",
      "SENT",
      "ACCEPTED",
      "ACCEPTED_CONDITIONAL",
      "REJECTED",
    ])
    .optional(),
  customerId: z.uuid().optional(),
  branchId: z.uuid().optional(),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

const notFound = () => new HTTPException(404, { message: "Comprobante no encontrado" });

// Cualquier miembro de la empresa (incluido el cajero) puede crear y emitir comprobantes.
export const documents = new Hono<AppEnv>()
  .get("/", zv("query", documentsQuery), async (c) => {
    const { q, page, pageSize, type, status, customerId, branchId, from, to } =
      c.req.valid("query");
    const digits = q?.replace(/[\s-]/g, "");
    const where: Prisma.DocumentWhereInput = {
      ...(type ? { type } : {}),
      ...(status ? { status } : {}),
      ...(customerId ? { customerId } : {}),
      ...(branchId ? { branchId } : {}),
      ...(from || to
        ? {
            createdAt: {
              ...(from ? { gte: new Date(`${from}T00:00:00-04:00`) } : {}),
              ...(to
                ? {
                    lt: new Date(new Date(`${to}T00:00:00-04:00`).getTime() + 86_400_000),
                  }
                : {}),
            },
          }
        : {}),
      ...(q
        ? {
            OR: [
              { encf: { contains: q.toUpperCase() } },
              { buyerName: { contains: q, mode: "insensitive" } },
              ...(digits ? [{ buyerDocNumber: { contains: digits } }] : []),
            ],
          }
        : {}),
    };
    const db = c.get("db");
    const [rows, total] = await Promise.all([
      db.document.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      db.document.count({ where }),
    ]);
    return c.json(pageOf(rows.map(documentSummaryDto), total, page, pageSize));
  })
  .get("/:id", zv("param", uuidParam), async (c) => {
    const doc = await c.get("db").document.findFirst({
      where: { id: c.req.valid("param").id },
      include: FULL,
    });
    if (!doc) throw notFound();
    const profile = await c.get("db").companyProfile.findFirst({ select: { rnc: true, environment: true } });
    return c.json({ data: documentDto(doc, profile) });
  })
  // Crea un borrador. Los totales siempre los calcula el servidor.
  .post("/", zv("json", documentInput), async (c) => {
    const input = c.req.valid("json");
    const organizationId = c.get("organizationId");
    const doc = await c.get("run")(async (tx) => {
      const { document, lines, payments } = await buildDraft(tx, input);
      const created = await tx.document.create({
        data: {
          ...document,
          organizationId,
          createdById: c.get("user").id,
          lines: { create: lines.map((l) => ({ ...l, organizationId })) },
          payments: { create: payments.map((p) => ({ ...p, organizationId })) },
        },
        include: FULL,
      });
      await tx.auditLog.create({
        data: auditEntry(c, "document.create", "document", created.id, {
          type: created.type,
          total: documentDto(created).totals.total,
        }),
      });
      return created;
    });
    return c.json({ data: documentDto(doc) }, 201);
  })
  // Reemplaza el contenido de un borrador.
  .put("/:id", zv("param", uuidParam), zv("json", documentInput), async (c) => {
    const { id } = c.req.valid("param");
    const input = c.req.valid("json");
    const organizationId = c.get("organizationId");
    const doc = await c.get("run")(async (tx) => {
      const current = await tx.document.findFirst({ where: { id } });
      if (!current) throw notFound();
      if (current.status !== "DRAFT") {
        throw new HTTPException(409, {
          message: "Un comprobante emitido no se puede modificar",
        });
      }

      const { document, lines, payments } = await buildDraft(tx, input);
      await tx.documentLine.deleteMany({ where: { documentId: id } });
      await tx.payment.deleteMany({ where: { documentId: id } });
      const updated = await tx.document.update({
        where: { id },
        data: {
          ...document,
          lines: { create: lines.map((l) => ({ ...l, organizationId })) },
          payments: { create: payments.map((p) => ({ ...p, organizationId })) },
        },
        include: FULL,
      });
      await tx.auditLog.create({
        data: auditEntry(c, "document.update", "document", id),
      });
      return updated;
    });
    return c.json({ data: documentDto(doc) });
  })
  .delete("/:id", zv("param", uuidParam), async (c) => {
    const { id } = c.req.valid("param");
    await c.get("run")(async (tx) => {
      const current = await tx.document.findFirst({ where: { id } });
      if (!current) throw notFound();
      if (current.status !== "DRAFT") {
        throw new HTTPException(409, {
          message:
            "Un comprobante emitido no se puede eliminar; corrígelo con una nota de crédito",
        });
      }
      await tx.document.delete({ where: { id } });
      await tx.auditLog.create({
        data: auditEntry(c, "document.delete", "document", id),
      });
    });
    return c.body(null, 204);
  })
  // Valida las reglas fiscales, asigna el e-NCF y congela el comprobante (ver lib/issue.ts).
  .post("/:id/issue", zv("param", uuidParam), async (c) => {
    const { id } = c.req.valid("param");
    const { doc, profile } = await c.get("run")(async (tx) => ({
      doc: await issueDocument(tx, { id, organizationId: c.get("organizationId"), userId: c.get("user").id, env: c.get("deps").env }),
      profile: await tx.companyProfile.findFirst({ select: { rnc: true, environment: true } }),
    }));
    return c.json({ data: documentDto(doc, profile) });
  })
  // Firma de una vez los comprobantes emitidos sin firma (por ejemplo, tras subir el certificado digital).
  // Cada uno va en su propia transacción: uno que no se pueda firmar no frena a los demás.
  .post("/sign-pending", requireRole("owner", "admin"), async (c) => {
    const organizationId = c.get("organizationId");
    const env = c.get("deps").env;
    const pending = await c.get("db").document.findMany({
      where: { status: { not: "DRAFT" }, signedAt: null, currency: "DOP" },
      select: { id: true, encf: true },
      orderBy: { issuedAt: "asc" },
      take: 200,
    });
    let signed = 0;
    const failed: { encf: string | null; error: string }[] = [];
    for (const doc of pending) {
      try {
        await c.get("run")(async (tx) => {
          const signedDoc = await signIssued(tx, env, organizationId, doc.id);
          const profile = await tx.companyProfile.findFirstOrThrow({ select: { sendToDgii: true } });
          await enqueueIfAuto(tx, organizationId, signedDoc, profile);
        });
        signed++;
      } catch (e) {
        failed.push({ encf: doc.encf, error: e instanceof HTTPException ? e.message : "Error interno" });
        // Sin certificado no tiene sentido seguir intentando con el resto.
        if (e instanceof HTTPException && e.status === 422 && /certificado/.test(e.message)) break;
      }
    }
    return c.json({ data: { signed, failed, remaining: Math.max(pending.length - signed - failed.length, 0) } });
  })
  // Firma un comprobante ya emitido que quedó sin firma (p. ej. una venta de la caja sin conexión, o emitido
  // antes de subir el certificado digital).
  .post("/:id/sign", requireRole("owner", "admin"), zv("param", uuidParam), async (c) => {
    const { id } = c.req.valid("param");
    const organizationId = c.get("organizationId");
    const { doc, profile } = await c.get("run")(async (tx) => {
      const signed = await signIssued(tx, c.get("deps").env, organizationId, id);
      const queued = await enqueueIfAuto(tx, organizationId, signed, await tx.companyProfile.findFirstOrThrow({ select: { sendToDgii: true } }));
      await tx.auditLog.create({ data: auditEntry(c, "document.sign", "document", id, { encf: signed.encf, securityCode: signed.securityCode }) });
      return {
        doc: queued ? await tx.document.findFirstOrThrow({ where: { id }, include: FULL }) : signed,
        profile: await tx.companyProfile.findFirst({ select: { rnc: true, environment: true } }),
      };
    });
    return c.json({ data: documentDto(doc, profile) });
  })
  // Pone el comprobante firmado en la cola de envío a la DGII (o vuelve a ponerlo si falló).
  .post("/:id/send", requireRole("owner", "admin"), zv("param", uuidParam), async (c) => {
    const { id } = c.req.valid("param");
    const organizationId = c.get("organizationId");
    const { doc, profile } = await c.get("run")(async (tx) => {
      const found = await tx.document.findFirst({ where: { id }, include: FULL });
      if (!found) throw notFound();
      const block = fiscalBlock(found);
      if (block) throw new HTTPException(422, { message: block });
      if (found.fiscalSubmission) {
        if (!(await retrySubmission(tx, id))) throw new HTTPException(409, { message: "Este comprobante ya está en la cola de la DGII" });
      } else {
        await enqueueSubmission(tx, organizationId, id);
      }
      await tx.auditLog.create({ data: auditEntry(c, "document.send", "document", id, { encf: found.encf }) });
      return {
        doc: await tx.document.findFirstOrThrow({ where: { id }, include: FULL }),
        profile: await tx.companyProfile.findFirst({ select: { rnc: true, environment: true } }),
      };
    });
    return c.json({ data: documentDto(doc, profile) });
  })
  // «Consultar ahora»: procesa este envío sin esperar a su hora (envía, o pregunta a la DGII por el resultado).
  .post("/:id/fiscal/refresh", requireRole("owner", "admin"), zv("param", uuidParam), async (c) => {
    const { id } = c.req.valid("param");
    const deps = c.get("deps");
    await processDue(
      { env: deps.env, prisma: deps.prisma, logger: deps.logger, ...(deps.fiscalFetch ? { fetch: deps.fiscalFetch } : {}) },
      { organizationId: c.get("organizationId"), documentId: id },
    );
    const doc = await c.get("db").document.findFirst({ where: { id }, include: FULL });
    if (!doc) throw notFound();
    const profile = await c.get("db").companyProfile.findFirst({ select: { rnc: true, environment: true } });
    return c.json({ data: documentDto(doc, profile) });
  });
