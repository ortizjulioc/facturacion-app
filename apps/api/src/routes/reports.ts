import { Hono } from "hono";
import { z } from "zod";
import { ECF_LABELS, fromCents, fromMilli, type EcfType } from "@facturacion/core";
import { zv } from "../lib/validator";
import { requireRole } from "../middleware/tenant";
import type { AppEnv } from "../types";

/**
 * Reportes de ventas. Reglas:
 *  - Solo cuentan comprobantes ya emitidos (no borradores), por fecha de emisión en hora de Santo Domingo.
 *  - Todo se expresa en pesos: los comprobantes en dólares se convierten con su tasa de cambio.
 *  - Las notas de crédito (E34) RESTAN; las de débito (E33) suman.
 */

const TZ = "America/Santo_Domingo";
const DAY_MS = 86_400_000;
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha inválida (AAAA-MM-DD)");

export const rangeQuery = z
  .object({
    from: isoDate,
    to: isoDate,
    groupBy: z.enum(["day", "month"]).default("day"),
  })
  .superRefine((v, ctx) => {
    const days = (Date.parse(v.to) - Date.parse(v.from)) / DAY_MS;
    if (Number.isNaN(days) || days < 0) {
      ctx.addIssue({
        code: "custom",
        path: ["to"],
        message: "La fecha final no puede ser anterior a la inicial",
      });
    } else if (days > 366) {
      ctx.addIssue({
        code: "custom",
        path: ["to"],
        message: "El rango máximo es de un año",
      });
    }
  });

/** [inicio, fin) del rango en hora local (UTC-4 todo el año, sin horario de verano). */
const bounds = (from: string, to: string) => ({
  start: new Date(`${from}T00:00:00-04:00`),
  end: new Date(Date.parse(`${to}T00:00:00-04:00`) + DAY_MS),
});

const m = (v: bigint | null | undefined) => fromCents(v ?? 0n);

type Money = bigint | null;
type SeriesRow = {
  period: Date;
  count: number;
  subtotal: Money;
  tax: Money;
  total: Money;
};

export const reports = new Hono<AppEnv>()
  .use("*", requireRole("owner", "admin"))
  .get("/sales", zv("query", rangeQuery), async (c) => {
    const { from, to, groupBy } = c.req.valid("query");
    const { start, end } = bounds(from, to);
    const unit = groupBy === "month" ? "month" : "day";

    const data = await c.get("run")(async (tx) => {
      // Filtro y conversión a pesos compartidos por todas las consultas.
      const series = await tx.$queryRaw<SeriesRow[]>`
        SELECT date_trunc(${unit}, d."issuedAt" AT TIME ZONE ${TZ})::date AS period,
               COUNT(*)::int AS count,
               SUM(CASE WHEN d."type" = 'E34' THEN -1 ELSE 1 END * ROUND(d."subtotal"::numeric * d."exchangeRate"))::bigint AS subtotal,
               SUM(CASE WHEN d."type" = 'E34' THEN -1 ELSE 1 END * ROUND(d."totalTax"::numeric * d."exchangeRate"))::bigint AS tax,
               SUM(CASE WHEN d."type" = 'E34' THEN -1 ELSE 1 END * ROUND(d."total"::numeric * d."exchangeRate"))::bigint AS total
        FROM "document" d
        WHERE d."status" <> 'DRAFT' AND d."issuedAt" >= ${start} AND d."issuedAt" < ${end}
        GROUP BY 1 ORDER BY 1`;

      const byType = await tx.$queryRaw<
        { type: EcfType; count: number; total: Money; tax: Money }[]
      >`
        SELECT d."type"::text AS type,
               COUNT(*)::int AS count,
               SUM(ROUND(d."total"::numeric * d."exchangeRate"))::bigint AS total,
               SUM(ROUND(d."totalTax"::numeric * d."exchangeRate"))::bigint AS tax
        FROM "document" d
        WHERE d."status" <> 'DRAFT' AND d."issuedAt" >= ${start} AND d."issuedAt" < ${end}
        GROUP BY d."type" ORDER BY d."type"`;

      const taxes = await tx.$queryRaw<
        {
          base18: Money;
          tax18: Money;
          base16: Money;
          tax16: Money;
          base0: Money;
          exempt: Money;
          propina: Money;
        }[]
      >`
        SELECT
          SUM(s * ROUND(d."base18"::numeric * d."exchangeRate"))::bigint AS base18,
          SUM(s * ROUND(d."tax18"::numeric * d."exchangeRate"))::bigint AS tax18,
          SUM(s * ROUND(d."base16"::numeric * d."exchangeRate"))::bigint AS base16,
          SUM(s * ROUND(d."tax16"::numeric * d."exchangeRate"))::bigint AS tax16,
          SUM(s * ROUND(d."base0"::numeric * d."exchangeRate"))::bigint AS base0,
          SUM(s * ROUND(d."baseExempt"::numeric * d."exchangeRate"))::bigint AS exempt,
          SUM(s * ROUND(d."propinaAmount"::numeric * d."exchangeRate"))::bigint AS propina
        FROM (
          SELECT *, (CASE WHEN "type" = 'E34' THEN -1 ELSE 1 END) AS s
          FROM "document"
          WHERE "status" <> 'DRAFT' AND "issuedAt" >= ${start} AND "issuedAt" < ${end}
        ) d`;

      const payments = await tx.$queryRaw<{ method: string; amount: Money }[]>`
        SELECT p."method"::text AS method, SUM(ROUND(p."amount"::numeric * d."exchangeRate"))::bigint AS amount
        FROM "payment" p JOIN "document" d ON d."id" = p."documentId"
        WHERE d."status" <> 'DRAFT' AND d."issuedAt" >= ${start} AND d."issuedAt" < ${end}
        GROUP BY p."method" ORDER BY amount DESC`;

      const products = await tx.$queryRaw<
        { name: string; quantity: bigint | null; total: Money }[]
      >`
        SELECT l."name" AS name,
               SUM(l."quantity")::bigint AS quantity,
               SUM(ROUND(l."total"::numeric * d."exchangeRate"))::bigint AS total
        FROM "document_line" l JOIN "document" d ON d."id" = l."documentId"
        WHERE d."status" <> 'DRAFT' AND d."type" <> 'E34'
          AND d."issuedAt" >= ${start} AND d."issuedAt" < ${end}
        GROUP BY COALESCE(l."productId"::text, l."name"), l."name"
        ORDER BY total DESC, name ASC
        LIMIT 10`;

      return { series, byType, tax: taxes[0], payments, products };
    });

    const net = data.series.reduce((sum, r) => sum + (r.total ?? 0n), 0n);
    const netTax = data.series.reduce((sum, r) => sum + (r.tax ?? 0n), 0n);
    const netSubtotal = data.series.reduce((sum, r) => sum + (r.subtotal ?? 0n), 0n);
    const t = data.tax;

    return c.json({
      data: {
        period: { from, to, groupBy },
        totals: {
          documents: data.series.reduce((n, r) => n + r.count, 0),
          subtotal: m(netSubtotal),
          tax: m(netTax),
          propina: m(t?.propina),
          net: m(net),
        },
        series: data.series.map((r) => ({
          period: r.period.toISOString().slice(0, 10),
          count: r.count,
          subtotal: m(r.subtotal),
          tax: m(r.tax),
          total: m(r.total),
        })),
        byType: data.byType.map((r) => ({
          type: r.type,
          label: ECF_LABELS[r.type],
          count: r.count,
          total: m(r.total),
          tax: m(r.tax),
        })),
        taxes: {
          base18: m(t?.base18),
          tax18: m(t?.tax18),
          base16: m(t?.base16),
          tax16: m(t?.tax16),
          base0: m(t?.base0),
          exempt: m(t?.exempt),
        },
        payments: data.payments.map((p) => ({ method: p.method, amount: m(p.amount) })),
        topProducts: data.products.map((p) => ({
          name: p.name,
          quantity: fromMilli(p.quantity ?? 0n),
          total: m(p.total),
        })),
      },
    });
  })
  // Listado plano de comprobantes emitidos del período, para Excel / el contador.
  .get("/sales.csv", zv("query", rangeQuery), async (c) => {
    const { from, to } = c.req.valid("query");
    const { start, end } = bounds(from, to);

    const docs = await c.get("db").document.findMany({
      where: { status: { not: "DRAFT" }, issuedAt: { gte: start, lt: end } },
      orderBy: [{ issuedAt: "asc" }, { encf: "asc" }],
    });

    const head = [
      "Fecha",
      "e-NCF",
      "Tipo",
      "Estado",
      "Documento comprador",
      "Comprador",
      "Moneda",
      "Tasa de cambio",
      "Monto gravado 18%",
      "ITBIS 18%",
      "Monto gravado 16%",
      "ITBIS 16%",
      "Gravado tasa 0%",
      "Exento",
      "Propina legal",
      "Total",
      "e-NCF modificado",
    ];
    const date = (d: Date | null) =>
      d ? new Intl.DateTimeFormat("sv-SE", { timeZone: TZ }).format(d) : "";
    const rows = docs.map((d) => [
      date(d.issuedAt),
      d.encf ?? "",
      d.type,
      d.status,
      d.buyerDocNumber ? `${d.buyerDocType} ${d.buyerDocNumber}` : "",
      d.buyerName ?? "",
      d.currency,
      d.exchangeRate.toString(),
      m(d.base18),
      m(d.tax18),
      m(d.base16),
      m(d.tax16),
      m(d.base0),
      m(d.baseExempt),
      m(d.propinaAmount),
      m(d.total),
      d.referencedEncf ?? "",
    ]);

    // Comillas dobles escapadas; si el texto empieza por = + - @ se neutraliza (inyección de fórmulas en Excel).
    const cell = (v: string) => {
      const safe = /^[=+@]|^-(?!\d)/.test(v) ? `'${v}` : v;
      return /[",\n\r;]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
    };
    const csv =
      "﻿" + [head, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";

    return new Response(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="ventas-${from}_${to}.csv"`,
      },
    });
  });
