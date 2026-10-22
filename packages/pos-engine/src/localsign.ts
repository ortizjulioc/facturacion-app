import { DOCUMENT_TYPES, parseEncf, toCents, toMilli, type DocumentType, type TaxCode } from "@facturacion/core";
import { buildEcf, sellerOf, signEcf, stampUrl, type EcfCertificate, type EcfInput, type EcfPaymentMethod } from "@facturacion/ecf";
import { getCustomer, getProduct, type Company } from "./catalog";
import type { SalePayload } from "./sales";
import { one, type Db } from "./store";

/** Lo que deja la firma local de una venta: se guarda con ella y se imprime en el ticket. */
export type SaleSignature = { xml: string; securityCode: string; signedAt: string; qrUrl: string };

/** Resultado de intentar firmar: la firma, o el motivo por el que la venta sale sin firmar (nunca bloquea la venta). */
export type SignOutcome = { signature: SaleSignature } | { error: string };
export type SaleSigner = (payload: SalePayload) => SignOutcome;

/**
 * Firmador de ventas de esta caja: arma el e-CF con los mismos datos que la nube y lo firma con el certificado de la
 * empresa, sin internet. Si algo impide firmar (certificado vencido, una cantidad que el e-CF no admite…) devuelve el
 * motivo y la venta sigue adelante sin firma: la nube la firmará al sincronizar.
 */
export function makeSigner(db: Db, cert: EcfCertificate, company: Company): SaleSigner {
  return (payload) => {
    try {
      const input = ecfInputOf(db, payload, company);
      const built = buildEcf(input);
      const signedAt = input.issuedAt;
      const signed = signEcf(built.xml, cert, signedAt);
      const buyerRnc =
        input.buyer && (input.buyer.docType === "RNC" || input.buyer.docType === "CEDULA") ? input.buyer.docNumber : null;
      const qrUrl = stampUrl({
        env: company.environment as "TEST" | "CERT" | "PROD",
        type: payload.type,
        sellerRnc: company.rnc,
        buyerRnc,
        encf: payload.encf,
        issuedAt: input.issuedAt,
        total: built.amounts.total,
        signedAt: signed.signedAt,
        securityCode: signed.securityCode,
      });
      return { signature: { xml: signed.xml, securityCode: signed.securityCode, signedAt: signed.signedAt.toISOString(), qrUrl } };
    } catch (e) {
      return { error: e instanceof Error ? e.message : "No se pudo firmar" };
    }
  };
}

const isDocType = (v: string | null | undefined): v is DocumentType => !!v && (DOCUMENT_TYPES as readonly string[]).includes(v);

function ecfInputOf(db: Db, p: SalePayload, company: Company): EcfInput {
  const customer = p.customerId ? getCustomer(db, p.customerId) : null;
  const docType = customer ? customer.documentType : (p.buyer?.docType ?? null);
  const docNumber = customer ? customer.documentNumber : (p.buyer?.docNumber ?? null);
  const name = customer ? customer.name : (p.buyer?.name ?? null);

  // E31: vencimiento del bloque al que pertenece el número.
  let sequenceExpiry: string | null = null;
  const n = parseEncf(p.encf);
  if (n && p.type === "E31") {
    sequenceExpiry =
      one<{ expires_at: string }>(db, "SELECT expires_at FROM seq_block WHERE ecf_type = ? AND from_number <= ? AND to_number >= ?", p.type, Number(n.sequence), Number(n.sequence))
        ?.expires_at ?? null;
  }

  // Nota de crédito: el comprobante que modifica (la fecha sale de la venta original, que está en esta misma caja).
  let reference: EcfInput["reference"] = null;
  if (p.type === "E34") {
    const original = one<{ issued_at: string }>(db, "SELECT issued_at FROM sale WHERE encf = ?", p.referencedEncf ?? "");
    if (!original || !p.referencedEncf) throw new Error("No se encontró en la caja el comprobante que se modifica");
    reference = { encf: p.referencedEncf, issuedAt: new Date(original.issued_at), code: (p.modificationCode ?? 3) as 1 | 2 | 3 | 4 | 5, reason: p.notes ?? null };
  }

  return {
    type: p.type,
    encf: p.encf,
    sequenceExpiry,
    issuedAt: new Date(p.issuedAt),
    seller: sellerOf({
      rnc: company.rnc,
      legalName: company.legalName,
      tradeName: company.tradeName,
      address: company.address,
      province: company.province ?? null,
      municipality: company.municipality ?? null,
      economicActivity: company.economicActivity ?? null,
      email: company.email ?? null,
      phone: company.phone,
    }),
    buyer: isDocType(docType) && docNumber ? { docType, docNumber, name } : null,
    lines: p.lines.map((l) => ({
      name: l.name,
      quantity: toMilli(l.quantity),
      unit: getProduct(db, l.productId)?.unit ?? null,
      unitPrice: toCents(l.unitPrice),
      priceIncludesTax: l.priceIncludesTax,
      tax: l.tax as TaxCode,
    })),
    propinaLegal: p.propinaLegal,
    payments: p.payments.map((x) => ({ method: x.method as EcfPaymentMethod, amount: toCents(x.amount) })),
    reference,
  };
}
