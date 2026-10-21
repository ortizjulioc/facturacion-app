import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { DOCUMENT_TYPES, fromCents, parseEncf, toCents } from "@facturacion/core";
import { Prisma } from "@facturacion/db";
import { auditEntry } from "../lib/audit";
import { buildDraft, documentDto, FULL, lineInput, paymentInput, type DocumentInput } from "../lib/documents";
import { issueDocument } from "../lib/issue";
import { money, optionalText } from "../lib/schemas";
import { zv } from "../lib/validator";
import type { AppEnv } from "../types";

/**
 * Sincronización con la caja (app Electron): la caja BAJA catálogos y bloques de e-NCF, y SUBE las ventas
 * que hizo sin conexión. Todo es idempotente: reintentar nunca duplica.
 */

const unprocessable = (message: string) => new HTTPException(422, { message });
const conflict = (message: string) => new HTTPException(409, { message });

const SALES_TYPES = ["E31", "E32"] as const;

// ───────────── Catálogo ─────────────

type Cursor = { p: [string, string] | null; c: [string, string] | null };

const encodeCursor = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString("base64url");
function decodeCursor(raw: string | undefined): Cursor {
  if (!raw) return { p: null, c: null };
  try {
    const v = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Cursor;
    const ok = (x: unknown) => x === null || (Array.isArray(x) && x.length === 2 && x.every((e) => typeof e === "string"));
    if (!ok(v.p) || !ok(v.c)) throw new Error("forma");
    return v;
  } catch {
    throw unprocessable("Cursor de sincronización inválido");
  }
}

/** Filas posteriores al cursor (fecha de modificación, luego id): no se salta ni se repite ninguna. */
const after = (cur: [string, string] | null) =>
  cur
    ? { OR: [{ updatedAt: { gt: new Date(cur[0]) } }, { updatedAt: new Date(cur[0]), id: { gt: cur[1] } }] }
    : {};

const catalogQuery = z.object({
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});

// ───────────── Bloques de e-NCF ─────────────

const blockBody = z.object({
  terminalId: z.uuid(),
  ecfType: z.enum(SALES_TYPES),
  /** Cuántos números se entregan a la caja. */
  size: z.number().int().min(1).max(5000),
});

type SequenceRow = Prisma.SequenceGetPayload<object>;
const blockDto = (s: SequenceRow) => ({
  id: s.id,
  terminalId: s.terminalId,
  ecfType: s.ecfType,
  fromNumber: Number(s.fromNumber),
  toNumber: Number(s.toNumber),
  /** Próximo número que la nube sabe sin usar (se actualiza al subir ventas). */
  nextNumber: Number(s.nextNumber),
  expiresAt: s.expiresAt.toISOString().slice(0, 10),
  remaining: Number(s.toNumber - s.nextNumber + 1n),
  active: s.active,
});

// ───────────── Subida de ventas ─────────────

const saleBody = z.object({
  /** Generado por la caja al vender: hace idempotente la subida. */
  clientId: z.uuid(),
  terminalId: z.uuid(),
  type: z.enum(SALES_TYPES),
  /** e-NCF que la caja ya asignó e imprimió, tomado de su bloque. */
  encf: z.string().regex(/^E3[12]\d{10}$/, "e-NCF inválido"),
  issuedAt: z.iso.datetime(),
  customerId: z.uuid().nullish(),
  buyer: z
    .object({
      name: z.string().trim().max(200).nullish(),
      docType: z.enum(DOCUMENT_TYPES).nullish(),
      docNumber: z.string().trim().max(30).nullish(),
    })
    .nullish(),
  propinaLegal: z.boolean().default(false),
  notes: optionalText(1000),
  lines: z.array(lineInput).min(1).max(500),
  payments: z.array(paymentInput).min(1).max(20),
  /** Total que la caja imprimió: debe coincidir con el que calcula la nube. */
  total: money,
});

export const sync = new Hono<AppEnv>()
  // Catálogos que cambiaron desde el cursor. Los productos y clientes inactivos también bajan (la caja los desactiva).
  .get("/catalog", zv("query", catalogQuery), async (c) => {
    const { cursor, limit } = c.req.valid("query");
    const cur = decodeCursor(cursor);
    const db = c.get("db");
    const [products, customers, categories, company] = await Promise.all([
      db.product.findMany({ where: after(cur.p), orderBy: [{ updatedAt: "asc" }, { id: "asc" }], take: limit }),
      db.customer.findMany({ where: after(cur.c), orderBy: [{ updatedAt: "asc" }, { id: "asc" }], take: limit }),
      db.category.findMany({ orderBy: { name: "asc" } }),
      db.companyProfile.findFirst(),
    ]);
    const last = <T extends { updatedAt: Date; id: string }>(rows: T[], prev: [string, string] | null) => {
      const l = rows.at(-1);
      return l ? ([l.updatedAt.toISOString(), l.id] as [string, string]) : prev;
    };
    return c.json({
      data: {
        products: products.map((p) => ({
          id: p.id,
          name: p.name,
          sku: p.sku,
          barcode: p.barcode,
          categoryId: p.categoryId,
          price: fromCents(p.price),
          priceIncludesTax: p.priceIncludesTax,
          tax: p.tax,
          unit: p.unit,
          allowsDecimals: p.allowsDecimals,
          trackInventory: p.trackInventory,
          active: p.active,
        })),
        customers: customers.map((x) => ({
          id: x.id,
          name: x.name,
          documentType: x.documentType,
          documentNumber: x.documentNumber,
          email: x.email,
          phone: x.phone,
          active: x.active,
        })),
        categories: categories.map((x) => ({ id: x.id, name: x.name })),
        company: company
          ? {
              legalName: company.legalName,
              tradeName: company.tradeName,
              rnc: company.rnc,
              address: company.address,
              phone: company.phone,
              environment: company.environment,
            }
          : null,
      },
      cursor: encodeCursor({ p: last(products, cur.p), c: last(customers, cur.c) }),
      /** true: quedan cambios por bajar; la caja vuelve a pedir con el cursor nuevo. */
      hasMore: products.length === limit || customers.length === limit,
      serverTime: new Date().toISOString(),
    });
  })
  // Bloques de e-NCF de una caja (con lo que queda).
  .get("/sequence-blocks", zv("query", z.object({ terminalId: z.uuid() })), async (c) => {
    const { terminalId } = c.req.valid("query");
    const rows = await c.get("db").sequence.findMany({
      where: { terminalId, offline: true, active: true },
      orderBy: [{ ecfType: "asc" }, { fromNumber: "asc" }],
    });
    return c.json({ data: rows.map(blockDto) });
  })
  // Entrega a la caja un bloque de números para facturar sin conexión. Se corta del FINAL de un rango general
  // vigente: el rango general queda más corto y el bloque pertenece solo a esa caja (la nube no asigna de él).
  .post("/sequence-blocks", zv("json", blockBody), async (c) => {
    const input = c.req.valid("json");
    const organizationId = c.get("organizationId");
    const block = await c.get("run")(async (tx) => {
      const terminal = await tx.terminal.findFirst({ where: { id: input.terminalId, active: true } });
      if (!terminal) throw unprocessable("La caja no existe o está inactiva");

      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "sequence"
        WHERE "ecfType" = ${input.ecfType}::"EcfType"
          AND "active" AND NOT "offline" AND "terminalId" IS NULL
          AND "expiresAt" >= (now() AT TIME ZONE 'America/Santo_Domingo')::date
          AND ("toNumber" - "nextNumber" + 1) >= ${input.size}::bigint
        ORDER BY "expiresAt", "fromNumber"
        LIMIT 1
        FOR UPDATE`;
      const pick = rows[0];
      if (!pick) {
        throw unprocessable(
          `No hay un rango general con ${input.size} números disponibles de ${input.ecfType}. Registra otro rango autorizado o pide un bloque más pequeño.`,
        );
      }
      const general = await tx.sequence.findFirstOrThrow({ where: { id: pick.id } });
      const from = general.toNumber - BigInt(input.size) + 1n;
      await tx.sequence.update({ where: { id: general.id }, data: { toNumber: from - 1n } });
      const created = await tx.sequence.create({
        data: {
          organizationId,
          ecfType: input.ecfType,
          fromNumber: from,
          toNumber: from + BigInt(input.size) - 1n,
          nextNumber: from,
          expiresAt: general.expiresAt,
          terminalId: terminal.id,
          offline: true,
        },
      });
      await tx.auditLog.create({
        data: auditEntry(c, "sync.block", "sequence", created.id, {
          terminal: terminal.code,
          ecfType: input.ecfType,
          from: Number(created.fromNumber),
          to: Number(created.toNumber),
        }),
      });
      return created;
    });
    return c.json({ data: blockDto(block) }, 201);
  })
  // Sube una venta hecha sin conexión: crea el comprobante ya emitido con el e-NCF de la caja.
  // Reintentar con el mismo `clientId` devuelve el comprobante existente.
  .post("/sales", zv("json", saleBody), async (c) => {
    const input = c.req.valid("json");
    const organizationId = c.get("organizationId");
    const userId = c.get("user").id;

    const upload = () => c.get("run")(async (tx) => {
      const existing = await tx.document.findFirst({ where: { clientId: input.clientId }, include: FULL });
      if (existing) return { doc: existing, duplicate: true };

      const terminal = await tx.terminal.findFirst({ where: { id: input.terminalId, active: true } });
      if (!terminal) throw unprocessable("La caja no existe o está inactiva");

      const parsed = parseEncf(input.encf);
      if (!parsed || parsed.type !== input.type) throw unprocessable("El e-NCF no corresponde al tipo de comprobante");
      const n = parsed.sequence;
      const block = await tx.sequence.findFirst({
        where: { terminalId: terminal.id, offline: true, ecfType: input.type, fromNumber: { lte: n }, toNumber: { gte: n } },
      });
      if (!block) throw unprocessable(`El e-NCF ${input.encf} no pertenece a un bloque entregado a esta caja`);
      const used = await tx.document.findFirst({ where: { encf: input.encf }, select: { id: true } });
      if (used) throw conflict(`El e-NCF ${input.encf} ya fue usado en otro comprobante`);

      const draftInput: DocumentInput = {
        type: input.type,
        branchId: terminal.branchId,
        terminalId: terminal.id,
        customerId: input.customerId ?? null,
        buyer: input.buyer ?? null,
        currency: "DOP",
        exchangeRate: "1",
        propinaLegal: input.propinaLegal,
        notes: input.notes ?? null,
        referencedDocumentId: null,
        modificationCode: null,
        lines: input.lines,
        payments: input.payments,
      };
      // Se factura a los precios y con los impuestos que la caja imprimió, aunque el producto cambie o se desactive.
      const { document, lines, payments } = await buildDraft(tx, draftInput, { allowInactiveProducts: true });
      if (document.total !== toCents(input.total)) {
        throw unprocessable(
          `El total de la caja (${input.total}) no coincide con el calculado (${fromCents(document.total)})`,
        );
      }
      const draft = await tx.document.create({
        data: {
          ...document,
          organizationId,
          createdById: userId,
          clientId: input.clientId,
          lines: { create: lines.map((l) => ({ ...l, organizationId })) },
          payments: { create: payments.map((p) => ({ ...p, organizationId })) },
        },
        select: { id: true },
      });
      const issued = await issueDocument(tx, {
        id: draft.id,
        organizationId,
        userId,
        preset: { encf: input.encf, issuedAt: new Date(input.issuedAt) },
      });
      // La nube registra hasta dónde llegó la caja (nunca retrocede).
      if (block.nextNumber <= n) await tx.sequence.update({ where: { id: block.id }, data: { nextNumber: n + 1n } });
      await tx.auditLog.create({
        data: auditEntry(c, "sync.sale", "document", issued.id, { encf: input.encf, clientId: input.clientId }),
      });
      return { doc: issued, duplicate: false };
    });

    let result: Awaited<ReturnType<typeof upload>>;
    try {
      result = await upload();
    } catch (e) {
      // Dos subidas simultáneas de la misma venta: la segunda choca con el índice único de `clientId`
      // y devuelve la que ganó (reintentar nunca duplica ni falla).
      if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2002") throw e;
      const winner = await c.get("db").document.findFirst({ where: { clientId: input.clientId }, include: FULL });
      if (!winner) throw e;
      result = { doc: winner, duplicate: true };
    }
    return c.json({ data: { ...documentDto(result.doc), duplicate: result.duplicate } }, result.duplicate ? 200 : 201);
  });
