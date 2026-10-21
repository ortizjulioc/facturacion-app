import type { Cents, DocumentType, EcfType, Milli, ModificationCode, TaxCode } from "@facturacion/core";

/** Ambiente de la DGII: TesteCF (pre-certificación), CerteCF (certificación) o eCF (producción). */
export type EcfEnvironment = "TEST" | "CERT" | "PROD";

/** Forma de pago de una venta, tal como la guarda la aplicación. */
export type EcfPaymentMethod = "CASH" | "TRANSFER" | "CHECK" | "CARD" | "CREDIT" | "OTHER";

export type EcfSeller = {
  /** RNC del emisor: 9 dígitos (persona jurídica) u 11 (cédula). */
  rnc: string;
  legalName: string;
  tradeName?: string | null;
  branch?: string | null;
  address: string;
  /** Código de 6 dígitos de la Tabla III de la DGII. */
  municipalityCode?: string | null;
  provinceCode?: string | null;
  /** Formato xxx-xxx-xxxx; máximo 3. */
  phones?: string[];
  email?: string | null;
  website?: string | null;
  economicActivity?: string | null;
  /** Número interno de la factura en el sistema del emisor. */
  internalInvoiceNumber?: string | null;
};

export type EcfBuyer = {
  docType: DocumentType;
  docNumber: string;
  name?: string | null;
  email?: string | null;
  address?: string | null;
  municipalityCode?: string | null;
  provinceCode?: string | null;
};

export type EcfLine = {
  name: string;
  description?: string | null;
  /** Código interno del artículo (se envía como código «Interna»). */
  code?: string | null;
  quantity: Milli;
  /** Unidad de la aplicación («UND», «KG»…): se traduce a la Tabla IV de la DGII. */
  unit?: string | null;
  /** Precio unitario en centavos; con `priceIncludesTax` ya trae el impuesto. */
  unitPrice: Cents;
  priceIncludesTax?: boolean;
  tax: TaxCode;
  /** Descuento de la línea en centavos (ya resuelto). */
  discount?: Cents;
  isService?: boolean;
};

export type EcfReference = {
  /** e-NCF del comprobante que se modifica. */
  encf: string;
  /** Fecha de emisión del comprobante modificado. */
  issuedAt: Date;
  code: ModificationCode;
  reason?: string | null;
};

export type EcfPayment = { method: EcfPaymentMethod; amount: Cents };

/** Tipo de ingreso (Tabla de la DGII): 01 operaciones (no financieras) es el habitual. */
export type EcfIncomeType = "01" | "02" | "03" | "04" | "05" | "06";

export type EcfInput = {
  type: EcfType;
  encf: string;
  /** Vencimiento de la secuencia, «AAAA-MM-DD». Obligatorio en E31 y E33; no se envía en E32 ni E34. */
  sequenceExpiry?: string | null;
  issuedAt: Date;
  seller: EcfSeller;
  buyer?: EcfBuyer | null;
  lines: EcfLine[];
  /** Restaurantes: 10 % de propina legal sobre el subtotal (impuesto adicional 001). */
  propinaLegal?: boolean;
  payments?: EcfPayment[];
  /** Fecha límite de pago, «AAAA-MM-DD» (ventas a crédito). */
  paymentDueDate?: string | null;
  incomeType?: EcfIncomeType;
  /** Obligatorio en E33 y E34. */
  reference?: EcfReference | null;
};

/** Montos del comprobante, en centavos: lo que va en el XML, útil también para validar y mostrar. */
export type EcfAmounts = {
  taxableI1: Cents;
  taxableI2: Cents;
  taxableI3: Cents;
  exempt: Cents;
  itbisI1: Cents;
  itbisI2: Cents;
  itbisI3: Cents;
  totalItbis: Cents;
  propinaLegal: Cents;
  total: Cents;
};

/** Error de datos que impiden armar un e-CF válido; el mensaje es para el usuario. */
export class EcfError extends Error {
  override name = "EcfError";
}
