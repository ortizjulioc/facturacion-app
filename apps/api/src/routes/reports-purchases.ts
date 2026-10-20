import { Hono } from "hono";
import { EXPENSE_TYPES, fromCents } from "@facturacion/core";
import { zv } from "../lib/validator";
import { KIND_LABELS, type PurchaseKindValue } from "../lib/purchases";
import { requireRole } from "../middleware/tenant";
import type { AppEnv } from "../types";
import { rangeQuery } from "./reports";

/**
 * Reporte de compras (base del formato 606). Reglas:
 *  - Solo compras REGISTRADAS (no borradores), por fecha del comprobante.
 *  - Todo en pesos: lo que está en dólares se convierte con la tasa de cambio de la compra.
 */

const m = (v: bigint | null | undefined) => fromCents(v ?? 0n);
type Money = bigint | null;

const PAYMENT_LABELS: Record<string, string> = {
  CASH: "Efectivo",
  TRANSFER: "Transferencia",
  CHECK: "Cheque",
  CARD: "Tarjeta",
  CREDIT: "Crédito",
  OTHER: "Otro",
};

export const purchaseReports = new Hono<AppEnv>()
  .use("*", requireRole("owner", "admin"))
  .get("/purchases", zv("query", rangeQuery), async (c) => {
    const { from, to, groupBy } = c.req.valid("query");
    const unit = groupBy === "month" ? "month" : "day";

    const data = await c.get("run")(async (tx) => {
      const series = await tx.$queryRaw<
        { period: Date; count: number; subtotal: Money; tax: Money; total: Money }[]
      >`
        SELECT date_trunc(${unit}, p."invoiceDate"::timestamp)::date AS period,
               COUNT(*)::int AS count,
               SUM(ROUND(p."subtotal"::numeric * p."exchangeRate"))::bigint AS subtotal,
               SUM(ROUND(p."totalTax"::numeric * p."exchangeRate"))::bigint AS tax,
               SUM(ROUND(p."total"::numeric * p."exchangeRate"))::bigint AS total
        FROM "purchase" p
        WHERE p."status" = 'POSTED' AND p."invoiceDate" >= ${from}::date AND p."invoiceDate" <= ${to}::date
        GROUP BY 1 ORDER BY 1`;

      const withheld = await tx.$queryRaw<{ itbis: Money; isr: Money }[]>`
        SELECT SUM(ROUND(p."itbisWithheld"::numeric * p."exchangeRate"))::bigint AS itbis,
               SUM(ROUND(p."isrWithheld"::numeric * p."exchangeRate"))::bigint AS isr
        FROM "purchase" p
        WHERE p."status" = 'POSTED' AND p."invoiceDate" >= ${from}::date AND p."invoiceDate" <= ${to}::date`;

      const byKind = await tx.$queryRaw<
        { kind: PurchaseKindValue; count: number; total: Money }[]
      >`
        SELECT p."kind"::text AS kind, COUNT(*)::int AS count,
               SUM(ROUND(p."total"::numeric * p."exchangeRate"))::bigint AS total
        FROM "purchase" p
        WHERE p."status" = 'POSTED' AND p."invoiceDate" >= ${from}::date AND p."invoiceDate" <= ${to}::date
        GROUP BY p."kind" ORDER BY total DESC`;

      const byExpense = await tx.$queryRaw<
        { expenseType: number; count: number; total: Money }[]
      >`
        SELECT p."expenseType" AS "expenseType", COUNT(*)::int AS count,
               SUM(ROUND(p."total"::numeric * p."exchangeRate"))::bigint AS total
        FROM "purchase" p
        WHERE p."status" = 'POSTED' AND p."invoiceDate" >= ${from}::date AND p."invoiceDate" <= ${to}::date
        GROUP BY p."expenseType" ORDER BY total DESC`;

      const suppliers = await tx.$queryRaw<
        { name: string | null; doc: string | null; count: number; total: Money }[]
      >`
        SELECT MAX(p."supplierName") AS name, MAX(p."supplierDocNumber") AS doc, COUNT(*)::int AS count,
               SUM(ROUND(p."total"::numeric * p."exchangeRate"))::bigint AS total
        FROM "purchase" p
        WHERE p."status" = 'POSTED' AND p."invoiceDate" >= ${from}::date AND p."invoiceDate" <= ${to}::date
        GROUP BY COALESCE(p."supplierId"::text, 'sin-proveedor')
        ORDER BY total DESC LIMIT 10`;

      return { series, withheld: withheld[0], byKind, byExpense, suppliers };
    });

    const sum = (pick: (r: (typeof data.series)[number]) => Money) =>
      data.series.reduce((acc, r) => acc + (pick(r) ?? 0n), 0n);

    return c.json({
      data: {
        period: { from, to, groupBy },
        totals: {
          documents: data.series.reduce((n, r) => n + r.count, 0),
          subtotal: m(sum((r) => r.subtotal)),
          tax: m(sum((r) => r.tax)),
          total: m(sum((r) => r.total)),
          itbisWithheld: m(data.withheld?.itbis),
          isrWithheld: m(data.withheld?.isr),
        },
        series: data.series.map((r) => ({
          period: r.period.toISOString().slice(0, 10),
          count: r.count,
          subtotal: m(r.subtotal),
          tax: m(r.tax),
          total: m(r.total),
        })),
        byKind: data.byKind.map((r) => ({
          kind: r.kind,
          label: KIND_LABELS[r.kind],
          count: r.count,
          total: m(r.total),
        })),
        byExpense: data.byExpense.map((r) => ({
          expenseType: r.expenseType,
          label: EXPENSE_TYPES[r.expenseType as keyof typeof EXPENSE_TYPES] ?? "",
          count: r.count,
          total: m(r.total),
        })),
        topSuppliers: data.suppliers.map((r) => ({
          name: r.name ?? "Sin proveedor (gastos menores)",
          documentNumber: r.doc,
          count: r.count,
          total: m(r.total),
        })),
      },
    });
  })
  // Listado plano de compras registradas, con las columnas que el contador necesita para el 606.
  .get("/purchases.csv", zv("query", rangeQuery), async (c) => {
    const { from, to } = c.req.valid("query");
    const rows = await c.get("db").purchase.findMany({
      where: {
        status: "POSTED",
        invoiceDate: {
          gte: new Date(`${from}T00:00:00Z`),
          lte: new Date(`${to}T00:00:00Z`),
        },
      },
      orderBy: [{ invoiceDate: "asc" }, { ncf: "asc" }],
    });

    const head = [
      "Fecha del comprobante",
      "RNC/Cédula del proveedor",
      "Tipo de identificación",
      "Proveedor",
      "Tipo de bienes y servicios (606)",
      "Descripción del tipo",
      "NCF",
      "Origen",
      "Moneda",
      "Tasa de cambio",
      "Monto facturado sin ITBIS",
      "ITBIS facturado",
      "ITBIS retenido",
      "Retención de renta (ISR)",
      "Total",
      "Forma de pago",
    ];
    const lines = rows.map((p) => [
      p.invoiceDate.toISOString().slice(0, 10),
      p.supplierDocNumber ?? "",
      // Convención del 606: 1 = RNC, 2 = cédula.
      p.supplierDocType === "RNC" ? "1" : p.supplierDocType === "CEDULA" ? "2" : "",
      p.supplierName ?? "",
      String(p.expenseType),
      EXPENSE_TYPES[p.expenseType as keyof typeof EXPENSE_TYPES] ?? "",
      p.ncf ?? "",
      KIND_LABELS[p.kind],
      p.currency,
      p.exchangeRate.toString(),
      m(p.subtotal),
      m(p.totalTax),
      m(p.itbisWithheld),
      m(p.isrWithheld),
      m(p.total),
      PAYMENT_LABELS[p.paymentMethod] ?? p.paymentMethod,
    ]);

    // Comillas escapadas; si el texto empieza por = + - @ se neutraliza (inyección de fórmulas en Excel).
    const cell = (v: string) => {
      const safe = /^[=+@]|^-(?!\d)/.test(v) ? `'${v}` : v;
      return /[",\n\r;]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
    };
    const csv =
      "﻿" + [head, ...lines].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";

    return new Response(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="compras-${from}_${to}.csv"`,
      },
    });
  });
