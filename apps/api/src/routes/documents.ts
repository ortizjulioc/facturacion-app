import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
  buyerErrors,
  ECF_TYPES,
  formatDop,
  isModifier,
  remainingCredit,
} from "@facturacion/core";
import type { Prisma } from "@facturacion/db";
import { auditEntry } from "../lib/audit";
import {
  buildDraft,
  documentDto,
  documentInput,
  documentSummaryDto,
  FULL,
} from "../lib/documents";
import { allocateEncf } from "../lib/encf";
import { applyDocumentStock } from "../lib/stock";
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
const unprocessable = (message: string) => new HTTPException(422, { message });

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
    return c.json({ data: documentDto(doc) });
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
  // Valida las reglas fiscales, asigna el e-NCF y congela el comprobante.
  .post("/:id/issue", zv("param", uuidParam), async (c) => {
    const { id } = c.req.valid("param");
    const doc = await c.get("run")(async (tx) => {
      const draft = await tx.document.findFirst({ where: { id }, include: FULL });
      if (!draft) throw notFound();
      if (draft.status !== "DRAFT") {
        throw new HTTPException(409, { message: "Este comprobante ya fue emitido" });
      }

      const profile = await tx.companyProfile.findFirst();
      if (!profile) {
        throw unprocessable(
          "Registra los datos fiscales de la empresa antes de emitir comprobantes",
        );
      }
      if (draft.total <= 0n)
        throw unprocessable("El total del comprobante debe ser mayor que cero");

      // El comprador se refresca desde la ficha del cliente: pudo cambiar desde que se creó el borrador.
      let buyer = {
        buyerName: draft.buyerName,
        buyerDocType: draft.buyerDocType,
        buyerDocNumber: draft.buyerDocNumber,
      };
      if (draft.customerId && !isModifier(draft.type)) {
        const customer = await tx.customer.findFirst({ where: { id: draft.customerId } });
        if (customer) {
          buyer = {
            buyerName: customer.name,
            buyerDocType: customer.documentType,
            buyerDocNumber: customer.documentNumber,
          };
        }
      }

      if (!isModifier(draft.type)) {
        const [problem] = buyerErrors(draft.type, draft.total, {
          docType: buyer.buyerDocType,
          docNumber: buyer.buyerDocNumber,
        });
        if (problem) throw unprocessable(problem);

        const paid = draft.payments.reduce((sum, p) => sum + p.amount, 0n);
        if (paid !== draft.total) {
          throw unprocessable(
            `Los pagos (${formatDop(paid)}) deben sumar el total del comprobante (${formatDop(draft.total)})`,
          );
        }
      }

      if (draft.type === "E34" && draft.referencedDocumentId) {
        // Se bloquea el comprobante original para que dos notas simultáneas no excedan su monto.
        await tx.$queryRaw`SELECT 1 FROM "document" WHERE "id" = ${draft.referencedDocumentId}::uuid FOR UPDATE`;
        const original = await tx.document.findFirstOrThrow({
          where: { id: draft.referencedDocumentId },
        });
        const credited = await tx.document.aggregate({
          _sum: { total: true },
          where: {
            referencedDocumentId: original.id,
            type: "E34",
            status: { not: "DRAFT" },
          },
        });
        const already = credited._sum.total ?? 0n;
        const left = remainingCredit(original.total, already);
        if (draft.total > left) {
          throw unprocessable(
            `La nota de crédito (${formatDop(draft.total)}) excede lo que queda por acreditar (${formatDop(left)})`,
          );
        }
        if (
          draft.modificationCode === 1 &&
          (already > 0n || draft.total !== original.total)
        ) {
          throw unprocessable(
            "Para anular el comprobante la nota debe ser por el total y no puede haber otras notas de crédito",
          );
        }
      }

      const encf = await allocateEncf(tx, draft.type, draft.terminalId);
      const issued = await tx.document.update({
        where: { id },
        data: { status: "ISSUED", encf, issuedAt: new Date(), ...buyer },
        include: FULL,
      });
      // Descuenta (o reingresa) las existencias en la misma transacción: si no hay stock, no se emite.
      await applyDocumentStock(tx, issued, c.get("user").id, profile.allowNegativeStock);
      await tx.auditLog.create({
        data: auditEntry(c, "document.issue", "document", id, {
          encf,
          type: issued.type,
          total: formatDop(issued.total),
        }),
      });
      return issued;
    });
    return c.json({ data: documentDto(doc) });
  });
