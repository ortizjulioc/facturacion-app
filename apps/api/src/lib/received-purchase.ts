import { HTTPException } from "hono/http-exception";
import { calculateDocument, DEFAULT_EXPENSE_TYPE, fromCents, fromMilli, toMilli, type TaxCode } from "@facturacion/core";
import { readIncomingBody, type IncomingBody } from "@facturacion/ecf";
import type { Prisma } from "@facturacion/db";
import { auditRow } from "./audit";
import { buildPurchaseDraft, FULL, postPurchase, type PurchaseFull, type PurchaseInput } from "./purchases";
import { formatDmyUtc } from "./receiver";
import type { TenantTx } from "../types";

const unprocessable = (message: string) => new HTTPException(422, { message });

/** Tipos de e-CF que un proveedor nos puede mandar y que se registran como compra con factura de proveedor. */
const PURCHASE_TYPES = new Set(["31", "32", "44", "45"]);
const TYPE_PROBLEMS: Record<string, string> = {
  "33": "Las notas de débito de proveedores aún no se registran como compra: regístrala a mano",
  "34": "Las notas de crédito de proveedores aún no se registran como compra: regístrala a mano",
};

export type PlanLine = {
  lineNumber: number;
  name: string;
  quantity: string;
  unitCost: string;
  tax: TaxCode;
  total: string;
  /** Producto del catálogo con el que se reconoció la línea: entra al inventario y actualiza su último costo. */
  match: { productId: string; productName: string; by: "code" | "name" | "manual" } | null;
};

export type PurchasePlan = {
  supplier: { id: string | null; name: string; rnc: string; willCreate: boolean };
  lines: PlanLine[];
  /** Total del e-CF y total que sale de las líneas (deberían coincidir; se tolera un centavo de redondeo por línea). */
  reportedTotal: string;
  computedTotal: string;
  warnings: string[];
  /** Entrada para crear la compra (ya validada). */
  input: PurchaseInput;
};

export type PlanOptions = {
  branchId?: string | null;
  expenseType?: number | null;
  paymentMethod?: PurchaseInput["paymentMethod"] | null;
  /** Producto de cada línea elegido a mano (null = ninguno, aunque coincida). */
  mappings?: Record<string, string | null>;
};

const normalizeName = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** Qué producto del catálogo es cada línea: por el código del proveedor (SKU o código de barras) o por el nombre exacto. */
async function matchProducts(tx: TenantTx, body: IncomingBody, mappings: PlanOptions["mappings"]) {
  const products = await tx.product.findMany({ where: { active: true }, select: { id: true, name: true, sku: true, barcode: true, allowsDecimals: true } });
  const byKey = new Map<string, (typeof products)[number]>();
  const byName = new Map<string, (typeof products)[number][]>();
  for (const p of products) {
    for (const key of [p.sku, p.barcode]) if (key) byKey.set(key.trim().toLowerCase(), p);
    const n = normalizeName(p.name);
    byName.set(n, [...(byName.get(n) ?? []), p]);
  }
  const byId = new Map(products.map((p) => [p.id, p]));
  return body.lines.map((line): PlanLine["match"] => {
    const manual = mappings && String(line.lineNumber) in mappings ? mappings[String(line.lineNumber)] : undefined;
    if (manual !== undefined) {
      if (manual === null) return null;
      const p = byId.get(manual);
      if (!p) throw unprocessable(`Línea ${line.lineNumber}: el producto elegido no existe o está inactivo`);
      return { productId: p.id, productName: p.name, by: "manual" };
    }
    for (const c of line.codes) {
      const p = byKey.get(c.code.trim().toLowerCase());
      if (p) return { productId: p.id, productName: p.name, by: "code" };
    }
    const named = byName.get(normalizeName(line.name));
    return named?.length === 1 ? { productId: named[0]!.id, productName: named[0]!.name, by: "name" } : null;
  });
}

/**
 * Cómo quedaría la compra que sale de un e-CF recibido: proveedor, líneas con su impuesto y a qué productos se
 * reconocen. No escribe nada; si algo impide registrarla (firma inválida, tipo no soportado, totales que no cuadran),
 * lanza el motivo.
 */
export async function planPurchase(tx: TenantTx, receivedId: string, opts: PlanOptions = {}): Promise<{ plan: PurchasePlan; row: Prisma.ReceivedDocumentGetPayload<object> }> {
  const row = await tx.receivedDocument.findFirst({ where: { id: receivedId } });
  if (!row) throw new HTTPException(404, { message: "Comprobante recibido no encontrado" });
  if (row.purchaseId) throw new HTTPException(409, { message: "Este e-CF ya está registrado como compra" });
  if (TYPE_PROBLEMS[row.ecfType]) throw unprocessable(TYPE_PROBLEMS[row.ecfType]!);
  if (!PURCHASE_TYPES.has(row.ecfType)) throw unprocessable("Este tipo de comprobante no se registra como compra");
  if (!row.signatureValid) throw unprocessable("No se puede registrar como compra un comprobante con la firma inválida");

  const body = readIncomingBody(row.xml);
  if (!body) throw unprocessable("No se pudieron leer las líneas del e-CF");
  const bad = body.lines.find((l) => l.tax === null);
  if (bad) throw unprocessable(`La línea ${bad.lineNumber} ("${bad.name}") es no facturable: regístrala a mano`);

  const supplier = await tx.supplier.findFirst({ where: { documentNumber: row.emitterRnc } });
  if (supplier && !supplier.active) throw unprocessable(`El proveedor ${supplier.name} está inactivo: actívalo para registrar sus compras`);

  let branchId = opts.branchId ?? null;
  if (!branchId) {
    const branches = await tx.branch.findMany({ where: { active: true }, select: { id: true }, take: 2 });
    if (branches.length !== 1) throw unprocessable(branches.length === 0 ? "Crea una sucursal para registrar compras" : "Elige la sucursal a la que entra la mercancía");
    branchId = branches[0]!.id;
  }

  const matches = await matchProducts(tx, body, opts.mappings);
  const lines = body.lines.map((l, i) => ({
    name: l.name,
    quantity: l.quantity,
    unitCost: fromCents(l.unitPrice),
    tax: l.tax!,
    priceIncludesTax: body.pricesIncludeTax,
    ...(l.discount > 0n ? { discount: { type: "amount" as const, amount: fromCents(l.discount) } } : {}),
    ...(matches[i] ? { productId: matches[i]!.productId } : {}),
  }));

  // Un producto que no se vende en fracciones no puede recibir 1.50: se avisa en vez de descartar la línea en silencio.
  const warnings: string[] = [];
  for (const [i, m] of matches.entries()) {
    const l = body.lines[i]!;
    if (m && toMilli(l.quantity) % 1000n !== 0n) {
      const p = await tx.product.findFirst({ where: { id: m.productId }, select: { allowsDecimals: true, name: true } });
      if (p && !p.allowsDecimals) throw unprocessable(`Línea ${l.lineNumber}: "${p.name}" no se maneja en fracciones y el e-CF trae ${l.quantity}`);
    }
  }

  const input: PurchaseInput = {
    kind: "SUPPLIER_INVOICE",
    branchId,
    supplierId: supplier?.id ?? null,
    ncf: row.encf,
    invoiceDate: row.issuedOn.toISOString().slice(0, 10),
    currency: "DOP",
    exchangeRate: "1",
    expenseType: opts.expenseType ?? DEFAULT_EXPENSE_TYPE,
    paymentMethod: opts.paymentMethod ?? body.paymentMethod ?? "CASH",
    notes: `Recibido como e-CF ${row.encf} del ${formatDmyUtc(row.issuedOn)}`,
    itbisWithheld: fromCents(body.itbisWithheld),
    isrWithheld: fromCents(body.isrWithheld),
    lines,
  };

  // Los totales salen de las líneas con las reglas fiscales de la aplicación: tienen que coincidir con los del e-CF.
  // La validación (retenciones, NCF repetido…) la hace `buildPurchaseDraft` al crear; aquí solo se compara el total.
  const computed = calculateDocument({
    lines: body.lines.map((l) => ({
      unitPrice: l.unitPrice,
      quantity: toMilli(l.quantity),
      tax: l.tax!,
      priceIncludesTax: body.pricesIncludeTax,
      ...(l.discount > 0n ? { discount: { type: "amount" as const, cents: l.discount } } : {}),
    })),
  });
  const slack = BigInt(body.lines.length); // un centavo de redondeo por línea
  const diff = computed.total > row.total ? computed.total - row.total : row.total - computed.total;
  if (diff > slack) {
    throw unprocessable(
      `El total que sale de las líneas (${fromCents(computed.total)}) no coincide con el del e-CF (${fromCents(row.total)}); probablemente trae impuestos adicionales o retenciones: regístralo a mano`,
    );
  }
  if (diff > 0n) warnings.push(`Diferencia de redondeo de ${fromCents(diff)} entre las líneas y el total del e-CF`);

  return {
    row,
    plan: {
      supplier: { id: supplier?.id ?? null, name: supplier?.name ?? row.emitterName ?? row.emitterRnc, rnc: row.emitterRnc, willCreate: !supplier },
      lines: body.lines.map((l, i) => ({
        lineNumber: l.lineNumber,
        name: l.name,
        quantity: fromMilli(toMilli(l.quantity)),
        unitCost: fromCents(l.unitPrice),
        tax: l.tax!,
        total: fromCents(l.amount),
        match: matches[i]!,
      })),
      reportedTotal: fromCents(row.total),
      computedTotal: fromCents(computed.total),
      warnings,
      input,
    },
  };
}

/**
 * Registra el e-CF recibido como compra de un clic: crea el proveedor si no existe (con los datos del e-CF), arma la
 * compra con el ITBIS de cada línea y, si `post`, la registra: entra al inventario lo que se reconoció como producto y
 * actualiza su último costo. Todo en la transacción de quien llama.
 */
export async function registerPurchase(
  tx: TenantTx,
  organizationId: string,
  userId: string,
  receivedId: string,
  opts: PlanOptions & { post: boolean },
): Promise<PurchaseFull> {
  const { plan, row } = await planPurchase(tx, receivedId, opts);
  const body = readIncomingBody(row.xml)!;

  let supplierId = plan.supplier.id;
  if (!supplierId) {
    const created = await tx.supplier.create({
      data: {
        organizationId,
        name: (row.emitterName ?? row.emitterRnc).slice(0, 200),
        documentType: row.emitterRnc.length === 11 ? "CEDULA" : "RNC",
        documentNumber: row.emitterRnc,
        email: body.seller.email,
        phone: body.seller.phone,
        address: body.seller.address,
      },
    });
    supplierId = created.id;
    await tx.auditLog.create({ data: auditRow({ organizationId, userId }, "supplier.create", "supplier", created.id, { from: "e-CF recibido", rnc: row.emitterRnc }) });
  }

  const { purchase: header, lines } = await buildPurchaseDraft(tx, { ...plan.input, supplierId });
  const created = await tx.purchase.create({
    data: { ...header, organizationId, createdById: userId, lines: { create: lines.map((l) => ({ ...l, organizationId })) } },
    include: FULL,
  });
  await tx.receivedDocument.update({ where: { id: receivedId }, data: { purchaseId: created.id } });
  await tx.auditLog.create({
    data: auditRow({ organizationId, userId }, "receiver.to_purchase", "received_document", receivedId, { purchaseId: created.id, encf: row.encf, total: fromCents(created.total) }),
  });
  return opts.post ? postPurchase(tx, organizationId, created.id, userId) : created;
}
