import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
  calculateDocument,
  convertCents,
  DEFAULT_EXPENSE_TYPE,
  EXPENSE_TYPES,
  fromCents,
  fromMilli,
  isIsrWithholdingType,
  normalizeSupplierNcf,
  retentionErrors,
  TAX_CODES,
  toCents,
  toMilli,
  unitCostFromBase,
  type DocumentTotals,
  type LineInput,
} from "@facturacion/core";
import { Prisma } from "@facturacion/db";
import { auditRow } from "./audit";
import { allocateEncf } from "./encf";
import { moveStock } from "./stock";
import { isoDate, money, optionalText, quantity } from "./schemas";
import type { TenantTx } from "../types";

export const PURCHASE_KINDS = ["SUPPLIER_INVOICE", "E41", "E43"] as const;
export type PurchaseKindValue = (typeof PURCHASE_KINDS)[number];

export const KIND_LABELS: Record<PurchaseKindValue, string> = {
  SUPPLIER_INVOICE: "Factura de proveedor",
  E41: "Comprobante de compras",
  E43: "Gasto menor",
};

// ───────────── Entrada ─────────────

const purchaseLine = z.object({
  productId: z.uuid().nullish(),
  /** Obligatorio cuando la línea no viene de un producto. */
  name: z.string().trim().min(1).max(200).optional(),
  quantity,
  /** Costo unitario: sin impuesto, salvo que `priceIncludesTax` sea true. */
  unitCost: money,
  tax: z.enum(TAX_CODES).optional(),
  priceIncludesTax: z.boolean().optional(),
  discount: z
    .discriminatedUnion("type", [
      z.object({ type: z.literal("percent"), bps: z.number().int().min(0).max(10_000) }),
      z.object({ type: z.literal("amount"), amount: money }),
    ])
    .optional(),
});

export const purchaseInput = z
  .object({
    kind: z.enum(PURCHASE_KINDS),
    branchId: z.uuid(),
    supplierId: z.uuid().nullish(),
    /** NCF que trae la factura del proveedor (solo en `SUPPLIER_INVOICE`). */
    ncf: z.string().trim().max(30).nullish(),
    invoiceDate: isoDate,
    currency: z.enum(["DOP", "USD"]).default("DOP"),
    exchangeRate: z
      .string()
      .regex(/^\d{1,6}(\.\d{1,4})?$/, "Tasa de cambio inválida")
      .default("1"),
    expenseType: z.number().int().min(1).max(11).default(DEFAULT_EXPENSE_TYPE),
    paymentMethod: z
      .enum(["CASH", "TRANSFER", "CHECK", "CARD", "CREDIT", "OTHER"])
      .default("CASH"),
    notes: optionalText(1000),
    itbisWithheld: money.default("0"),
    isrWithheld: money.default("0"),
    /** 606: fecha de pago y tipo de retención en ISR (se pueden completar después de registrar, con `PATCH /:id/dgii`). */
    paymentDate: isoDate.nullish(),
    isrWithholdingType: z.number().int().min(1).max(9).nullish(),
    lines: z.array(purchaseLine).min(1, "Agrega al menos una línea").max(500),
  })
  .superRefine((v, ctx) => {
    if (v.currency === "DOP" && Number(v.exchangeRate) !== 1) {
      ctx.addIssue({
        code: "custom",
        path: ["exchangeRate"],
        message: "En pesos la tasa de cambio es 1",
      });
    }
    if (v.currency === "USD" && Number(v.exchangeRate) <= 1) {
      ctx.addIssue({
        code: "custom",
        path: ["exchangeRate"],
        message: "Indica la tasa de cambio del dólar",
      });
    }
  });

export type PurchaseInput = z.infer<typeof purchaseInput>;

// ───────────── Construcción del borrador ─────────────

const unprocessable = (message: string) => new HTTPException(422, { message });

/** Valida las reglas de cada tipo de compra y calcula los totales (siempre en el servidor). */
export async function buildPurchaseDraft(
  tx: TenantTx,
  input: PurchaseInput,
  existingId?: string,
) {
  const branch = await tx.branch.findFirst({
    where: { id: input.branchId, active: true },
  });
  if (!branch) throw unprocessable("La sucursal no existe o está inactiva");

  // Proveedor: obligatorio salvo en gastos menores.
  let supplier: Prisma.SupplierGetPayload<object> | null = null;
  if (input.supplierId) {
    supplier = await tx.supplier.findFirst({
      where: { id: input.supplierId, active: true },
    });
    if (!supplier) throw unprocessable("El proveedor no existe o está inactivo");
  } else if (input.kind !== "E43") {
    throw unprocessable("Elige el proveedor");
  }

  // NCF: solo la factura de proveedor trae el suyo; E41 y E43 reciben el e-NCF de la empresa al registrarse.
  let ncf: string | null = null;
  if (input.kind === "SUPPLIER_INVOICE") {
    ncf = normalizeSupplierNcf(input.ncf ?? "");
    if (!ncf)
      throw unprocessable(
        "El NCF del proveedor no es válido (por ejemplo B0100000123 o E310000000045)",
      );
    const duplicate = await tx.purchase.findFirst({
      where: {
        supplierId: supplier!.id,
        ncf,
        ...(existingId ? { id: { not: existingId } } : {}),
      },
      select: { id: true },
    });
    if (duplicate)
      throw new HTTPException(409, {
        message: "Ya registraste una compra de este proveedor con ese NCF",
      });
  } else if (input.ncf) {
    throw unprocessable(
      "El NCF lo asigna el sistema en los comprobantes de compras y gastos menores",
    );
  }

  // Productos.
  const productIds = [
    ...new Set(input.lines.flatMap((l) => (l.productId ? [l.productId] : []))),
  ];
  if (input.kind === "E43" && productIds.length > 0) {
    throw unprocessable("Los gastos menores no llevan productos de inventario");
  }
  const products = productIds.length
    ? await tx.product.findMany({ where: { id: { in: productIds } } })
    : [];
  const byId = new Map(products.map((p) => [p.id, p]));

  const resolved = input.lines.map((l, i) => {
    const where = `Línea ${i + 1}`;
    const product = l.productId ? byId.get(l.productId) : undefined;
    if (l.productId && !product) throw unprocessable(`${where}: el producto no existe`);
    if (product && !product.active)
      throw unprocessable(`${where}: "${product.name}" está inactivo`);

    const name = l.name ?? product?.name;
    const tax = l.tax ?? product?.tax;
    if (!name || !tax)
      throw unprocessable(`${where}: indica descripción e impuesto, o elige un producto`);
    const qty = toMilli(l.quantity);
    if (qty <= 0n) throw unprocessable(`${where}: la cantidad debe ser mayor que cero`);
    if (product && !product.allowsDecimals && qty % 1000n !== 0n) {
      throw unprocessable(`${where}: "${product.name}" no se maneja en fracciones`);
    }

    const discount: LineInput["discount"] = !l.discount
      ? undefined
      : l.discount.type === "percent"
        ? { type: "percent", bps: l.discount.bps }
        : { type: "amount", cents: toCents(l.discount.amount) };

    return {
      core: {
        unitPrice: toCents(l.unitCost),
        quantity: qty,
        tax,
        priceIncludesTax: l.priceIncludesTax ?? false,
        ...(discount ? { discount } : {}),
      } satisfies LineInput,
      productId: product?.id ?? null,
      name,
      unit: product?.unit ?? "UND",
    };
  });

  let totals: DocumentTotals;
  try {
    totals = calculateDocument({ lines: resolved.map((r) => r.core) });
  } catch (e) {
    throw unprocessable(
      e instanceof Error ? e.message : "No se pudieron calcular los totales",
    );
  }

  const itbisWithheld = toCents(input.itbisWithheld);
  const isrWithheld = toCents(input.isrWithheld);
  if (input.kind === "E43" && (itbisWithheld > 0n || isrWithheld > 0n)) {
    throw unprocessable("Los gastos menores no llevan retenciones");
  }
  const [retentionProblem] = retentionErrors({
    totalTax: totals.totalTax,
    subtotal: totals.subtotal,
    itbisWithheld,
    isrWithheld,
  });
  if (retentionProblem) throw unprocessable(retentionProblem);

  if (input.paymentDate && input.paymentDate < input.invoiceDate) {
    throw unprocessable("La fecha de pago no puede ser anterior a la del comprobante");
  }
  if (input.isrWithholdingType && !isIsrWithholdingType(input.isrWithholdingType)) {
    throw unprocessable("Tipo de retención en ISR inválido");
  }

  const lines = resolved.map((r, i) => {
    const t = totals.lines[i]!;
    return {
      lineNumber: i + 1,
      productId: r.productId,
      name: r.name,
      unit: r.unit,
      quantity: r.core.quantity,
      unitCost: r.core.unitPrice,
      priceIncludesTax: r.core.priceIncludesTax,
      tax: r.core.tax,
      discountType: r.core.discount
        ? r.core.discount.type === "percent"
          ? "PERCENT"
          : "AMOUNT"
        : null,
      discountValue: r.core.discount
        ? r.core.discount.type === "percent"
          ? BigInt(r.core.discount.bps)
          : r.core.discount.cents
        : null,
      gross: t.gross,
      discount: t.discount,
      base: t.base,
      taxAmount: t.taxAmount,
      total: t.total,
    };
  });

  const purchase = {
    kind: input.kind,
    branchId: input.branchId,
    supplierId: supplier?.id ?? null,
    supplierName: supplier?.name ?? null,
    supplierDocType: supplier?.documentType ?? null,
    supplierDocNumber: supplier?.documentNumber ?? null,
    ncf,
    invoiceDate: new Date(`${input.invoiceDate}T00:00:00Z`),
    currency: input.currency,
    exchangeRate: input.exchangeRate,
    expenseType: input.expenseType,
    paymentMethod: input.paymentMethod,
    notes: input.notes ?? null,
    totalDiscount: totals.totalDiscount,
    subtotal: totals.subtotal,
    base18: totals.byTax.ITBIS18.base,
    tax18: totals.byTax.ITBIS18.taxAmount,
    base16: totals.byTax.ITBIS16.base,
    tax16: totals.byTax.ITBIS16.taxAmount,
    base0: totals.byTax.ITBIS0.base,
    baseExempt: totals.byTax.EXENTO.base,
    totalTax: totals.totalTax,
    total: totals.total,
    itbisWithheld,
    isrWithheld,
    paymentDate: input.paymentDate ? new Date(`${input.paymentDate}T00:00:00Z`) : null,
    isrWithholdingType: isrWithheld > 0n ? (input.isrWithholdingType ?? null) : null,
  };

  return { purchase, lines };
}

// ───────────── Salida ─────────────

export type PurchaseFull = Prisma.PurchaseGetPayload<{ include: { lines: true } }>;

export const FULL = {
  lines: { orderBy: { lineNumber: "asc" } },
} satisfies Prisma.PurchaseInclude;

const m = (v: bigint) => fromCents(v);

export const purchaseSummaryDto = (p: Prisma.PurchaseGetPayload<object>) => ({
  id: p.id,
  kind: p.kind,
  kindLabel: KIND_LABELS[p.kind],
  status: p.status,
  ncf: p.ncf,
  supplierId: p.supplierId,
  supplierName: p.supplierName,
  supplierDocType: p.supplierDocType,
  supplierDocNumber: p.supplierDocNumber,
  invoiceDate: p.invoiceDate.toISOString().slice(0, 10),
  currency: p.currency,
  total: m(p.total),
  expenseType: p.expenseType,
  expenseLabel: EXPENSE_TYPES[p.expenseType as keyof typeof EXPENSE_TYPES] ?? "",
  postedAt: p.postedAt,
  createdAt: p.createdAt,
});

export const purchaseDto = (p: PurchaseFull) => ({
  ...purchaseSummaryDto(p),
  branchId: p.branchId,
  exchangeRate: p.exchangeRate.toString(),
  paymentMethod: p.paymentMethod,
  paymentDate: p.paymentDate ? p.paymentDate.toISOString().slice(0, 10) : null,
  isrWithholdingType: p.isrWithholdingType,
  notes: p.notes,
  totals: {
    discount: m(p.totalDiscount),
    subtotal: m(p.subtotal),
    base18: m(p.base18),
    tax18: m(p.tax18),
    base16: m(p.base16),
    tax16: m(p.tax16),
    base0: m(p.base0),
    baseExempt: m(p.baseExempt),
    tax: m(p.totalTax),
    total: m(p.total),
    itbisWithheld: m(p.itbisWithheld),
    isrWithheld: m(p.isrWithheld),
  },
  lines: p.lines.map((l) => ({
    lineNumber: l.lineNumber,
    productId: l.productId,
    name: l.name,
    unit: l.unit,
    quantity: fromMilli(l.quantity),
    unitCost: m(l.unitCost),
    priceIncludesTax: l.priceIncludesTax,
    tax: l.tax,
    discount: m(l.discount),
    discountInput:
      l.discountType === "PERCENT" && l.discountValue !== null
        ? ({ type: "percent", bps: Number(l.discountValue) } as const)
        : l.discountType === "AMOUNT" && l.discountValue !== null
          ? ({ type: "amount", amount: m(l.discountValue) } as const)
          : null,
    base: m(l.base),
    taxAmount: m(l.taxAmount),
    total: m(l.total),
  })),
});

const notFound = () => new HTTPException(404, { message: "Compra no encontrada" });

/**
 * Entrada al inventario por una compra registrada (salvo gastos menores).
 * El costo guardado es el unitario NETO (sin impuesto) y en pesos; también actualiza el "último costo"
 * del producto, aunque no controle inventario.
 */
async function applyPurchaseStock(tx: TenantTx, purchase: PurchaseFull, userId: string) {
  const perProduct = new Map<string, { qty: bigint; base: bigint }>();
  for (const line of purchase.lines) {
    if (!line.productId) continue;
    const acc = perProduct.get(line.productId) ?? { qty: 0n, base: 0n };
    acc.qty += line.quantity;
    acc.base += convertCents(line.base, purchase.exchangeRate.toString());
    perProduct.set(line.productId, acc);
  }
  if (perProduct.size === 0) return;

  const products = await tx.product.findMany({
    where: { id: { in: [...perProduct.keys()] } },
    select: { id: true, name: true, trackInventory: true },
  });
  // Orden estable: evita bloqueos cruzados entre registros concurrentes.
  for (const product of products.sort((a, b) => a.id.localeCompare(b.id))) {
    const { qty, base } = perProduct.get(product.id)!;
    const unitCost = unitCostFromBase(base, qty);
    if (product.trackInventory) {
      await moveStock(tx, {
        organizationId: purchase.organizationId,
        userId,
        productId: product.id,
        productName: product.name,
        branchId: purchase.branchId,
        delta: qty,
        type: "RECEIPT",
        allowNegative: true,
        unitCost,
        purchaseId: purchase.id,
        reason: `Compra ${purchase.ncf ?? ""}`.trim(),
      });
    }
    await tx.product.update({ where: { id: product.id }, data: { lastCost: unitCost } });
  }
}

/**
 * Registra una compra en borrador: asigna el e-NCF (E41/E43), da entrada al inventario y la congela. La usan el botón
 * «Registrar» de una compra y el registro de un e-CF recibido como compra.
 */
export async function postPurchase(tx: TenantTx, organizationId: string, id: string, userId: string): Promise<PurchaseFull> {
  const draft = await tx.purchase.findFirst({ where: { id }, include: FULL });
  if (!draft) throw notFound();
  if (draft.status !== "DRAFT") throw new HTTPException(409, { message: "Esta compra ya está registrada" });
  if (draft.total <= 0n) throw unprocessable("El total de la compra debe ser mayor que cero");

  // El proveedor se refresca desde su ficha: pudo cambiar desde que se creó el borrador.
  let supplier = {
    supplierName: draft.supplierName,
    supplierDocType: draft.supplierDocType,
    supplierDocNumber: draft.supplierDocNumber,
  };
  if (draft.supplierId) {
    const s = await tx.supplier.findFirst({ where: { id: draft.supplierId } });
    if (s) {
      supplier = { supplierName: s.name, supplierDocType: s.documentType, supplierDocNumber: s.documentNumber };
    }
  }

  let ncf = draft.ncf;
  if (draft.kind !== "SUPPLIER_INVOICE") {
    if (draft.kind === "E41" && !supplier.supplierDocNumber) {
      throw unprocessable("El comprobante de compras exige que el proveedor tenga cédula o RNC");
    }
    const profile = await tx.companyProfile.findFirst();
    if (!profile) throw unprocessable("Registra los datos fiscales de la empresa antes de emitir comprobantes");
    ncf = await allocateEncf(tx, draft.kind, null);
  }

  const posted = await tx.purchase.update({
    where: { id },
    data: { status: "POSTED", postedAt: new Date(), ncf, ...supplier },
    include: FULL,
  });
  if (draft.kind !== "E43") await applyPurchaseStock(tx, posted, userId);
  await tx.auditLog.create({
    data: auditRow({ organizationId, userId }, "purchase.post", "purchase", id, { kind: posted.kind, ncf, total: fromCents(posted.total) }),
  });
  return posted;
}
