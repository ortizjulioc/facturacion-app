import {
  buyerErrors,
  calculateDocument,
  isModifier,
  normalizeDocument,
  parseEncf,
  PROPINA_LEGAL_BPS,
  type Cents,
  type DocumentTotals,
  type LineInput,
  type TaxCode,
} from "@facturacion/core";
import {
  clean,
  formatAmount,
  formatDate,
  formatDateOnly,
  formatQuantity,
  formatUnitPrice,
  leaf,
  node,
  serialize,
  type XmlNode,
} from "./format";
import { EcfError, type EcfAmounts, type EcfInput, type EcfLine, type EcfPaymentMethod } from "./types";

/** Tabla I: código del impuesto adicional «Propina legal». */
const PROPINA_TAX_CODE = "001";

/** Tabla IV (unidades de medida) de la DGII para las unidades que usa la aplicación. */
const UNIT_CODES: Record<string, string> = {
  BARR: "1", BOL: "2", BOT: "5", BOTELLA: "5", CAJ: "6", DOC: "13", GL: "15", GAL: "15", GR: "17", HR: "19",
  HORA: "19", KG: "21", KWH: "22", LB: "23", LT: "24", L: "24", LITRO: "24", M: "26", M2: "27", M3: "28",
  PAQ: "31", PAR: "32", PZA: "34", ROL: "35", UND: "43", EA: "44", Q: "51", BDJ: "57",
};
const DEFAULT_UNIT_CODE = "43";

export const unitCode = (unit: string | null | undefined): string =>
  (unit && UNIT_CODES[unit.trim().toUpperCase()]) || DEFAULT_UNIT_CODE;

/** IndicadorFacturacion de cada línea. */
const BILLING_INDICATOR: Record<TaxCode, string> = { ITBIS18: "1", ITBIS16: "2", ITBIS0: "3", EXENTO: "4" };

/** FormaPago de la DGII: 1 efectivo, 2 cheque/transferencia/depósito, 3 tarjeta, 4 crédito, 8 otras. */
const PAYMENT_CODES: Record<EcfPaymentMethod, string> = {
  CASH: "1",
  TRANSFER: "2",
  CHECK: "2",
  CARD: "3",
  CREDIT: "4",
  OTHER: "8",
};

const DAY_MS = 24 * 60 * 60 * 1000;
const NAME_MAX = 80;

export type BuiltEcf = {
  /** `<ECF>…</ECF>` sin firmar y sin FechaHoraFirma (la agrega la firma). */
  xml: string;
  amounts: EcfAmounts;
  totals: DocumentTotals;
};

function toLineInput(line: EcfLine): LineInput {
  return {
    unitPrice: line.unitPrice,
    quantity: line.quantity,
    tax: line.tax,
    priceIncludesTax: line.priceIncludesTax ?? false,
    ...(line.discount && line.discount > 0n ? { discount: { type: "amount" as const, cents: line.discount } } : {}),
  };
}

function checkInput(input: EcfInput, total: Cents): void {
  const encf = parseEncf(input.encf);
  if (!encf || `E${encf.type.slice(1)}` !== input.type) {
    throw new EcfError(`El e-NCF "${input.encf}" no corresponde a un comprobante ${input.type}`);
  }
  if (input.lines.length === 0) throw new EcfError("El comprobante necesita al menos una línea");
  if (input.lines.length > 1000) throw new EcfError("El e-CF admite un máximo de 1,000 líneas");
  if ((input.type === "E31" || input.type === "E33") && !input.sequenceExpiry) {
    throw new EcfError("Falta la fecha de vencimiento de la secuencia del e-NCF");
  }
  if (isModifier(input.type) && !input.reference) {
    throw new EcfError("Una nota de débito o crédito debe indicar el comprobante que modifica");
  }
  if (input.buyer) {
    const doc = normalizeDocument(input.buyer.docType, input.buyer.docNumber);
    if (!doc.ok) throw new EcfError(doc.error);
  }
  const errors = buyerErrors(input.type, total, {
    docType: input.buyer?.docType ?? null,
    docNumber: input.buyer?.docNumber ?? null,
  });
  if (errors.length > 0) throw new EcfError(errors[0]!);
  const gross = new Set(input.lines.map((l) => l.priceIncludesTax ?? false));
  if (gross.size > 1) throw new EcfError("Todas las líneas deben tener los precios con o sin ITBIS, no mezclados");
}

/** Armado del e-CF a partir de los datos de la venta; sin firmar. */
export function buildEcf(input: EcfInput): BuiltEcf {
  const totals = calculateDocument({
    lines: input.lines.map(toLineInput),
    ...(input.propinaLegal ? { propinaLegal: true } : {}),
  });
  checkInput(input, totals.total);

  const { byTax } = totals;
  const taxable = byTax.ITBIS18.base + byTax.ITBIS16.base + byTax.ITBIS0.base;
  const amounts: EcfAmounts = {
    taxableI1: byTax.ITBIS18.base,
    taxableI2: byTax.ITBIS16.base,
    taxableI3: byTax.ITBIS0.base,
    exempt: byTax.EXENTO.base,
    itbisI1: byTax.ITBIS18.taxAmount,
    itbisI2: byTax.ITBIS16.taxAmount,
    itbisI3: byTax.ITBIS0.taxAmount,
    totalItbis: totals.totalTax,
    propinaLegal: totals.propinaLegal,
    total: totals.total,
  };
  if (amounts.total !== taxable + amounts.exempt + amounts.totalItbis + amounts.propinaLegal) {
    throw new EcfError("Los montos del comprobante no cuadran");
  }

  const root: XmlNode = {
    name: "ECF",
    children: [
      encabezado(input, amounts, totals),
      detalles(input, totals),
      referencia(input),
    ],
  };
  return { xml: serialize(root), amounts, totals };
}

function encabezado(input: EcfInput, a: EcfAmounts, totals: DocumentTotals): XmlNode {
  return {
    name: "Encabezado",
    children: [
      leaf("Version", "1.0"),
      idDoc(input, a),
      emisor(input),
      comprador(input),
      totales(a, totals),
    ],
  };
}

function idDoc(input: EcfInput, a: EcfAmounts): XmlNode | null {
  const isCredit = input.payments?.length ? input.payments.every((p) => p.method === "CREDIT") : false;
  const paymentType = a.total === 0n ? "3" : isCredit ? "2" : "1";
  const grossPrices = input.lines.some((l) => l.priceIncludesTax);

  // El número de forma de pago se agrupa: la DGII admite hasta 7 filas, una por forma.
  const byMethod = new Map<string, Cents>();
  const payments = input.payments?.length ? input.payments : [{ method: "CASH" as const, amount: a.total }];
  for (const p of payments) {
    const code = PAYMENT_CODES[p.method];
    byMethod.set(code, (byMethod.get(code) ?? 0n) + p.amount);
  }
  const paymentTable =
    input.type === "E34" || a.total === 0n
      ? null
      : node(
          "TablaFormasPago",
          ...[...byMethod].map(([code, amount]) =>
            node("FormaDePago", leaf("FormaPago", code), leaf("MontoPago", formatAmount(amount))),
          ),
        );

  const daysSince = input.reference ? (input.issuedAt.getTime() - input.reference.issuedAt.getTime()) / DAY_MS : 0;

  return node(
    "IdDoc",
    leaf("TipoeCF", input.type.slice(1)),
    leaf("eNCF", input.encf),
    input.type === "E31" || input.type === "E33" ? leaf("FechaVencimientoSecuencia", formatDateOnly(input.sequenceExpiry!)) : null,
    input.type === "E34" ? leaf("IndicadorNotaCredito", daysSince > 30 ? "1" : "0") : null,
    leaf("IndicadorMontoGravado", grossPrices ? "1" : "0"),
    leaf("TipoIngresos", input.incomeType ?? "01"),
    leaf("TipoPago", paymentType),
    paymentType === "2" && input.paymentDueDate ? leaf("FechaLimitePago", formatDateOnly(input.paymentDueDate)) : null,
    paymentTable,
  );
}

function emisor(input: EcfInput): XmlNode | null {
  const s = input.seller;
  const rnc = normalizeDocument(s.rnc.length === 11 ? "CEDULA" : "RNC", s.rnc);
  if (!rnc.ok) throw new EcfError(`RNC del emisor: ${rnc.error}`);
  const phones = (s.phones ?? []).slice(0, 3);
  return node(
    "Emisor",
    leaf("RNCEmisor", rnc.value),
    leaf("RazonSocialEmisor", clean(s.legalName, 150)),
    leaf("NombreComercial", s.tradeName ? clean(s.tradeName, 150) : null),
    leaf("Sucursal", s.branch ? clean(s.branch, 20) : null),
    leaf("DireccionEmisor", clean(s.address, 100)),
    leaf("Municipio", s.municipalityCode),
    leaf("Provincia", s.provinceCode),
    phones.length ? node("TablaTelefonoEmisor", ...phones.map((p) => leaf("TelefonoEmisor", p))) : null,
    leaf("CorreoEmisor", s.email ? clean(s.email, 80) : null),
    leaf("WebSite", s.website ? clean(s.website, 50) : null),
    leaf("ActividadEconomica", s.economicActivity ? clean(s.economicActivity, 100) : null),
    leaf("NumeroFacturaInterna", s.internalInvoiceNumber ? clean(s.internalInvoiceNumber, 20) : null),
    leaf("FechaEmision", formatDate(input.issuedAt)),
  );
}

function comprador(input: EcfInput): XmlNode | null {
  const b = input.buyer;
  if (!b) return null;
  const doc = normalizeDocument(b.docType, b.docNumber);
  if (!doc.ok) throw new EcfError(doc.error);
  const foreign = b.docType === "PASAPORTE";
  return node(
    "Comprador",
    foreign ? null : leaf("RNCComprador", doc.value),
    foreign ? leaf("IdentificadorExtranjero", doc.value) : null,
    leaf("RazonSocialComprador", b.name ? clean(b.name, 150) : null),
    leaf("CorreoComprador", b.email ? clean(b.email, 80) : null),
    leaf("DireccionComprador", b.address ? clean(b.address, 100) : null),
    leaf("MunicipioComprador", b.municipalityCode),
    leaf("ProvinciaComprador", b.provinceCode),
  );
}

function totales(a: EcfAmounts, totals: DocumentTotals): XmlNode | null {
  const has = (v: Cents) => v !== 0n;
  const taxable = a.taxableI1 + a.taxableI2 + a.taxableI3;
  const hasTaxable = taxable !== 0n || totals.lines.some((l) => l.tax !== "EXENTO");
  const propina = a.propinaLegal;
  return node(
    "Totales",
    hasTaxable ? leaf("MontoGravadoTotal", formatAmount(taxable)) : null,
    has(a.taxableI1) ? leaf("MontoGravadoI1", formatAmount(a.taxableI1)) : null,
    has(a.taxableI2) ? leaf("MontoGravadoI2", formatAmount(a.taxableI2)) : null,
    has(a.taxableI3) ? leaf("MontoGravadoI3", formatAmount(a.taxableI3)) : null,
    has(a.exempt) ? leaf("MontoExento", formatAmount(a.exempt)) : null,
    has(a.taxableI1) ? leaf("ITBIS1", "18") : null,
    has(a.taxableI2) ? leaf("ITBIS2", "16") : null,
    has(a.taxableI3) ? leaf("ITBIS3", "0") : null,
    hasTaxable ? leaf("TotalITBIS", formatAmount(a.totalItbis)) : null,
    has(a.taxableI1) ? leaf("TotalITBIS1", formatAmount(a.itbisI1)) : null,
    has(a.taxableI2) ? leaf("TotalITBIS2", formatAmount(a.itbisI2)) : null,
    has(a.taxableI3) ? leaf("TotalITBIS3", formatAmount(a.itbisI3)) : null,
    has(propina) ? leaf("MontoImpuestoAdicional", formatAmount(propina)) : null,
    has(propina)
      ? node(
          "ImpuestosAdicionales",
          node(
            "ImpuestoAdicional",
            leaf("TipoImpuesto", PROPINA_TAX_CODE),
            leaf("TasaImpuestoAdicional", PROPINA_LEGAL_BPS / 100),
            leaf("OtrosImpuestosAdicionales", formatAmount(propina)),
          ),
        )
      : null,
    leaf("MontoTotal", formatAmount(a.total)),
  );
}

function detalles(input: EcfInput, totals: DocumentTotals): XmlNode | null {
  return node(
    "DetallesItems",
    ...input.lines.map((line, i) => {
      const calc = totals.lines[i]!;
      const monto = calc.gross - calc.discount;
      return node(
        "Item",
        leaf("NumeroLinea", i + 1),
        line.code
          ? node("TablaCodigosItem", node("CodigosItem", leaf("TipoCodigo", "Interna"), leaf("CodigoItem", clean(line.code, 35))))
          : null,
        leaf("IndicadorFacturacion", BILLING_INDICATOR[line.tax]),
        leaf("NombreItem", clean(line.name, NAME_MAX) || "Artículo"),
        leaf("IndicadorBienoServicio", line.isService ? "2" : "1"),
        leaf("DescripcionItem", line.description ? clean(line.description, 1000) : null),
        leaf("CantidadItem", formatQuantity(line.quantity)),
        leaf("UnidadMedida", unitCode(line.unit)),
        leaf("PrecioUnitarioItem", formatUnitPrice(line.unitPrice)),
        calc.discount > 0n ? leaf("DescuentoMonto", formatAmount(calc.discount)) : null,
        calc.discount > 0n
          ? node("TablaSubDescuento", node("SubDescuento", leaf("TipoSubDescuento", "$"), leaf("MontoSubDescuento", formatAmount(calc.discount))))
          : null,
        input.propinaLegal ? node("TablaImpuestoAdicional", node("ImpuestoAdicional", leaf("TipoImpuesto", PROPINA_TAX_CODE))) : null,
        leaf("MontoItem", formatAmount(monto)),
      );
    }),
  );
}

function referencia(input: EcfInput): XmlNode | null {
  const r = input.reference;
  if (!r) return null;
  return node(
    "InformacionReferencia",
    leaf("NCFModificado", r.encf),
    leaf("FechaNCFModificado", formatDate(r.issuedAt)),
    leaf("CodigoModificacion", r.code),
    leaf("RazonModificacion", r.reason ? clean(r.reason, 90) : null),
  );
}
