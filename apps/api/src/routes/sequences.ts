import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { ECF_TYPES } from "@facturacion/core";
import type { Prisma } from "@facturacion/db";
import { auditEntry } from "../lib/audit";
import { uuidParam } from "../lib/schemas";
import { zv } from "../lib/validator";
import { requireRole } from "../middleware/tenant";
import type { AppEnv } from "../types";

type SequenceRow = Prisma.SequenceGetPayload<object>;

// Los números caben de sobra en un `number` (máximo 9,999,999,999).
export const sequenceDto = (s: SequenceRow) => ({
  id: s.id,
  ecfType: s.ecfType,
  fromNumber: Number(s.fromNumber),
  toNumber: Number(s.toNumber),
  nextNumber: Number(s.nextNumber),
  remaining: Number(s.toNumber - s.nextNumber + 1n),
  expiresAt: s.expiresAt.toISOString().slice(0, 10),
  terminalId: s.terminalId,
  active: s.active,
});

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha inválida (AAAA-MM-DD)");
const number10 = z.number().int().min(1).max(9_999_999_999);

const createSequence = z
  .object({
    ecfType: z.enum(ECF_TYPES),
    fromNumber: number10,
    toNumber: number10,
    expiresAt: isoDate,
    terminalId: z.uuid().nullish(),
  })
  .refine((v) => v.fromNumber <= v.toNumber, {
    message: "El número inicial no puede ser mayor que el final",
    path: ["toNumber"],
  });

const updateSequence = z.object({
  active: z.boolean().optional(),
  expiresAt: isoDate.optional(),
  toNumber: number10.optional(),
});

const canWrite = requireRole("owner", "admin");

export const sequences = new Hono<AppEnv>()
  .get("/", async (c) => {
    const rows = await c.get("db").sequence.findMany({
      orderBy: [{ ecfType: "asc" }, { fromNumber: "asc" }],
    });
    return c.json({ data: rows.map(sequenceDto) });
  })
  .post("/", canWrite, zv("json", createSequence), async (c) => {
    const input = c.req.valid("json");
    const from = BigInt(input.fromNumber);
    const to = BigInt(input.toNumber);

    const seq = await c.get("run")(async (tx) => {
      if (input.terminalId) {
        const terminal = await tx.terminal.findFirst({ where: { id: input.terminalId, active: true } });
        if (!terminal) throw new HTTPException(422, { message: "La caja no existe o está inactiva" });
      }
      // Dos rangos del mismo tipo no pueden solaparse: darían e-NCF duplicados.
      const overlap = await tx.sequence.findFirst({
        where: { ecfType: input.ecfType, fromNumber: { lte: to }, toNumber: { gte: from } },
      });
      if (overlap) {
        throw new HTTPException(409, {
          message: `El rango se solapa con otro ya registrado (${overlap.fromNumber}–${overlap.toNumber})`,
        });
      }

      const created = await tx.sequence.create({
        data: {
          organizationId: c.get("organizationId"),
          ecfType: input.ecfType,
          fromNumber: from,
          toNumber: to,
          nextNumber: from,
          expiresAt: new Date(`${input.expiresAt}T00:00:00Z`),
          terminalId: input.terminalId ?? null,
        },
      });
      await tx.auditLog.create({
        data: auditEntry(c, "sequence.create", "sequence", created.id, {
          ecfType: created.ecfType,
          from: input.fromNumber,
          to: input.toNumber,
        }),
      });
      return created;
    });
    return c.json({ data: sequenceDto(seq) }, 201);
  })
  .patch("/:id", canWrite, zv("param", uuidParam), zv("json", updateSequence), async (c) => {
    const { id } = c.req.valid("param");
    const input = c.req.valid("json");

    const seq = await c.get("run")(async (tx) => {
      const current = await tx.sequence.findFirst({ where: { id } });
      if (!current) throw new HTTPException(404, { message: "Secuencia no encontrada" });

      if (input.toNumber !== undefined) {
        const to = BigInt(input.toNumber);
        if (to < current.nextNumber - 1n) {
          throw new HTTPException(422, { message: "El número final no puede ser menor que los e-NCF ya emitidos" });
        }
        const overlap = await tx.sequence.findFirst({
          where: {
            id: { not: id },
            ecfType: current.ecfType,
            fromNumber: { lte: to },
            toNumber: { gte: current.fromNumber },
          },
        });
        if (overlap) throw new HTTPException(409, { message: "El nuevo rango se solapa con otro registrado" });
      }

      const updated = await tx.sequence.update({
        where: { id },
        data: {
          ...(input.active === undefined ? {} : { active: input.active }),
          ...(input.expiresAt === undefined ? {} : { expiresAt: new Date(`${input.expiresAt}T00:00:00Z`) }),
          ...(input.toNumber === undefined ? {} : { toNumber: BigInt(input.toNumber) }),
        },
      });
      await tx.auditLog.create({
        data: auditEntry(c, "sequence.update", "sequence", id, { fields: Object.keys(input) }),
      });
      return updated;
    });
    return c.json({ data: sequenceDto(seq) });
  });
