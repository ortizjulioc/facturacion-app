import { Hono } from "hono";
import { zv } from "../lib/validator";
import { z } from "zod";
import {
  calculateDocument,
  fromCents,
  PROPINA_LEGAL_BPS,
  TAX_CODES,
  TAX_LABELS,
  TAX_RATE_BPS,
  toCents,
  toMilli,
  type DocumentTotals,
  type TaxCode,
} from "@facturacion/core";
import { money, quantity } from "../lib/schemas";
import type { AppEnv } from "../types";

const line = z.object({
  unitPrice: money,
  quantity,
  tax: z.enum(TAX_CODES),
  priceIncludesTax: z.boolean().default(false),
  discount: z
    .discriminatedUnion("type", [
      z.object({ type: z.literal("percent"), bps: z.number().int().min(0).max(10_000) }),
      z.object({ type: z.literal("amount"), amount: money }),
    ])
    .optional(),
});

const calculateBody = z.object({
  lines: z.array(line).min(1).max(500),
  propinaLegal: z.boolean().default(false),
});

const out = (cents: bigint) => fromCents(cents);

const totalsDto = (t: DocumentTotals) => ({
  lines: t.lines.map((l) => ({
    tax: l.tax,
    gross: out(l.gross),
    discount: out(l.discount),
    base: out(l.base),
    taxAmount: out(l.taxAmount),
    total: out(l.total),
  })),
  byTax: Object.fromEntries(
    TAX_CODES.map((code) => [
      code,
      { base: out(t.byTax[code].base), taxAmount: out(t.byTax[code].taxAmount) },
    ]),
  ) as Record<TaxCode, { base: string; taxAmount: string }>,
  totalDiscount: out(t.totalDiscount),
  subtotal: out(t.subtotal),
  totalTax: out(t.totalTax),
  propinaLegal: out(t.propinaLegal),
  total: out(t.total),
});

export const calculate = new Hono<AppEnv>()
  // Catálogo fijo de impuestos para llenar selectores en la web y la caja.
  .get("/tax-codes", (c) =>
    c.json({
      data: TAX_CODES.map((code) => ({
        code,
        label: TAX_LABELS[code],
        rateBps: TAX_RATE_BPS[code],
      })),
      propinaLegalBps: PROPINA_LEGAL_BPS,
    }),
  )
  // Mismo motor que usará la facturación: la caja y la web muestran totales idénticos a los fiscales.
  .post("/calculate", zv("json", calculateBody), (c) => {
    const body = c.req.valid("json");
    const totals = calculateDocument({
      propinaLegal: body.propinaLegal,
      lines: body.lines.map((l) => ({
        unitPrice: toCents(l.unitPrice),
        quantity: toMilli(l.quantity),
        tax: l.tax,
        priceIncludesTax: l.priceIncludesTax,
        ...(l.discount
          ? {
              discount:
                l.discount.type === "percent"
                  ? ({ type: "percent", bps: l.discount.bps } as const)
                  : ({ type: "amount", cents: toCents(l.discount.amount) } as const),
            }
          : {}),
      })),
    });
    return c.json({ data: totalsDto(totals) });
  });
