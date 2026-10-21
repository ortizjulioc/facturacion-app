import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { fromCents, toCents } from "@facturacion/core";
import type { Prisma } from "@facturacion/db";
import { auditEntry } from "../lib/audit";
import { isoDate, money, pageOf, uuidParam } from "../lib/schemas";
import { frozenReport, shiftReport, type DocumentReader } from "../lib/shifts";
import { zv } from "../lib/validator";
import type { AppEnv } from "../types";

const unprocessable = (message: string) => new HTTPException(422, { message });
const conflict = (message: string) => new HTTPException(409, { message });
const notFound = () => new HTTPException(404, { message: "Turno no encontrado" });

const isAdmin = (role: string) => role.split(",").some((r) => ["owner", "admin"].includes(r.trim()));

const DAY_MS = 86_400_000;
/** [inicio, fin) de un rango de fechas en hora local (UTC-4 todo el año). */
const bounds = (from: string, to: string) => ({
  gte: new Date(`${from}T00:00:00-04:00`),
  lt: new Date(Date.parse(`${to}T00:00:00-04:00`) + DAY_MS),
});

const openBody = z.object({
  terminalId: z.uuid(),
  /** Fondo de caja con el que se abre. */
  openingAmount: money.default("0"),
});
const closeBody = z.object({
  /** Efectivo contado en la gaveta. */
  countedCash: money,
  /** Obligatorio cuando el efectivo contado no coincide con el esperado. */
  notes: z.string().trim().max(500).nullish(),
});
const listQuery = z.object({
  terminalId: z.uuid().optional(),
  status: z.enum(["OPEN", "CLOSED"]).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
const currentQuery = z.object({ terminalId: z.uuid() });

const INCLUDE = { terminal: { select: { id: true, name: true, code: true, branchId: true } } } satisfies Prisma.CashShiftInclude;
type ShiftRow = Prisma.CashShiftGetPayload<{ include: typeof INCLUDE }>;

const m = (v: bigint | null) => (v === null ? null : fromCents(v));

const shiftDto = (s: ShiftRow, names: Map<string, string>) => ({
  id: s.id,
  status: s.status,
  terminal: s.terminal,
  openedBy: { id: s.openedById, name: names.get(s.openedById) ?? null },
  openedAt: s.openedAt,
  openingAmount: fromCents(s.openingAmount),
  closedBy: s.closedById ? { id: s.closedById, name: names.get(s.closedById) ?? null } : null,
  closedAt: s.closedAt,
  countedCash: m(s.countedCash),
  expectedCash: m(s.expectedCash),
  difference: m(s.difference),
  notes: s.notes,
});

/** Nombres de las personas que abrieron y cerraron (la tabla de usuarios no es por empresa). */
async function namesOf(c: Context<AppEnv>, shifts: ShiftRow[]) {
  const ids = [...new Set(shifts.flatMap((s) => [s.openedById, ...(s.closedById ? [s.closedById] : [])]))];
  if (ids.length === 0) return new Map<string, string>();
  const users = await c.get("db").user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  return new Map(users.map((u) => [u.id, u.name]));
}

export const shifts = new Hono<AppEnv>()
  // Turnos de la empresa. El cajero (member) solo ve los suyos; el administrador ve todos.
  .get("/", zv("query", listQuery), async (c) => {
    const { terminalId, status, from, to, page, pageSize } = c.req.valid("query");
    const admin = isAdmin(c.get("role"));
    const where: Prisma.CashShiftWhereInput = {
      ...(admin ? {} : { openedById: c.get("user").id }),
      ...(terminalId ? { terminalId } : {}),
      ...(status ? { status } : {}),
      ...(from && to ? { openedAt: bounds(from, to) } : {}),
    };
    const db = c.get("db");
    const [rows, total] = await Promise.all([
      db.cashShift.findMany({
        where,
        orderBy: { openedAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: INCLUDE,
      }),
      db.cashShift.count({ where }),
    ]);
    const names = await namesOf(c, rows);
    return c.json(pageOf(rows.map((r) => shiftDto(r, names)), total, page, pageSize));
  })
  // Turno abierto de una caja, con el informe X en vivo (null si no hay).
  .get("/current", zv("query", currentQuery), async (c) => {
    const { terminalId } = c.req.valid("query");
    const db = c.get("db");
    const reader = db as unknown as DocumentReader; // el cliente del tenant lee igual que una transacción
    const shift = await db.cashShift.findFirst({ where: { terminalId, status: "OPEN" }, include: INCLUDE });
    if (!shift) return c.json({ data: null });
    if (!isAdmin(c.get("role")) && shift.openedById !== c.get("user").id) {
      throw new HTTPException(403, { message: "Esa caja tiene un turno abierto por otra persona" });
    }
    const [names, report] = await Promise.all([namesOf(c, [shift]), shiftReport(reader, shift)]);
    const { expectedCashCents: _ignored, ...x } = report;
    return c.json({ data: { ...shiftDto(shift, names), report: x } });
  })
  .get("/:id", zv("param", uuidParam), async (c) => {
    const { id } = c.req.valid("param");
    const db = c.get("db");
    const shift = await db.cashShift.findFirst({ where: { id }, include: INCLUDE });
    if (!shift) throw notFound();
    if (!isAdmin(c.get("role")) && shift.openedById !== c.get("user").id) throw notFound();
    const names = await namesOf(c, [shift]);
    // Cerrado: el informe Z congelado; abierto: el X en vivo.
    const report = shift.closingReport ?? frozenReport(await shiftReport(db as unknown as DocumentReader, shift));
    return c.json({ data: { ...shiftDto(shift, names), report } });
  })
  .post("/", zv("json", openBody), async (c) => {
    const input = c.req.valid("json");
    const organizationId = c.get("organizationId");
    const userId = c.get("user").id;
    const shift = await c.get("run")(async (tx) => {
      // Con RLS, una caja de otra empresa no existe para este tenant.
      const terminal = await tx.terminal.findFirst({ where: { id: input.terminalId, active: true } });
      if (!terminal) throw unprocessable("La caja no existe o está inactiva");
      // Serializa aperturas simultáneas de la misma caja (el índice único parcial es la última defensa).
      await tx.$queryRaw`SELECT 1 FROM "terminal" WHERE "id" = ${terminal.id}::uuid FOR UPDATE`;
      const open = await tx.cashShift.findFirst({ where: { terminalId: terminal.id, status: "OPEN" } });
      if (open) throw conflict("Esa caja ya tiene un turno abierto");

      const created = await tx.cashShift.create({
        data: { organizationId, terminalId: terminal.id, openedById: userId, openingAmount: toCents(input.openingAmount) },
        include: INCLUDE,
      });
      await tx.auditLog.create({
        data: auditEntry(c, "shift.open", "cash_shift", created.id, {
          terminal: terminal.code,
          openingAmount: input.openingAmount,
        }),
      });
      return created;
    });
    return c.json({ data: shiftDto(shift, new Map([[shift.openedById, c.get("user").name]])) }, 201);
  })
  // Cierra el turno: cuenta el efectivo, calcula el cuadre y congela el informe Z.
  .post("/:id/close", zv("param", uuidParam), zv("json", closeBody), async (c) => {
    const { id } = c.req.valid("param");
    const input = c.req.valid("json");
    const userId = c.get("user").id;
    const closed = await c.get("run")(async (tx) => {
      // Bloquea el turno: las emisiones en curso (que lo leen con FOR SHARE) terminan antes de calcular el informe,
      // y las posteriores ya lo ven cerrado.
      await tx.$queryRaw`SELECT 1 FROM "cash_shift" WHERE "id" = ${id}::uuid FOR UPDATE`;
      const shift = await tx.cashShift.findFirst({ where: { id }, include: INCLUDE });
      if (!shift) throw notFound();
      if (shift.status !== "OPEN") throw conflict("El turno ya está cerrado");
      if (!isAdmin(c.get("role")) && shift.openedById !== userId) {
        throw new HTTPException(403, { message: "Solo quien abrió el turno o un administrador puede cerrarlo" });
      }

      const report = await shiftReport(tx, shift);
      const counted = toCents(input.countedCash);
      const difference = counted - report.expectedCashCents;
      if (difference !== 0n && !input.notes) {
        throw unprocessable("El efectivo contado no coincide con el esperado: indica el motivo de la diferencia");
      }
      const frozen = { ...frozenReport(report), countedCash: fromCents(counted), difference: fromCents(difference) };
      const updated = await tx.cashShift.update({
        where: { id },
        data: {
          status: "CLOSED",
          closedById: userId,
          closedAt: new Date(),
          countedCash: counted,
          expectedCash: report.expectedCashCents,
          difference,
          notes: input.notes ?? null,
          closingReport: frozen,
        },
        include: INCLUDE,
      });
      await tx.auditLog.create({
        data: auditEntry(c, "shift.close", "cash_shift", id, {
          expectedCash: fromCents(report.expectedCashCents),
          countedCash: input.countedCash,
          difference: fromCents(difference),
        }),
      });
      return { updated, frozen };
    });
    const names = await namesOf(c, [closed.updated]);
    return c.json({ data: { ...shiftDto(closed.updated, names), report: closed.frozen } });
  });
