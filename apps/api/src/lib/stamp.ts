import type { EcfType } from "@facturacion/core";
import { stampUrl } from "@facturacion/ecf";
import type { Prisma } from "@facturacion/db";

/** Lo que hace falta de la empresa para armar la dirección del QR. */
export type StampProfile = Pick<Prisma.CompanyProfileGetPayload<object>, "rnc" | "environment">;

export type Stamp = { securityCode: string; signedAt: Date; qrUrl: string };

/** Datos de la representación impresa: código de seguridad y dirección del QR. null si el comprobante no está firmado. */
export function stampOf(
  doc: Pick<Prisma.DocumentGetPayload<object>, "type" | "encf" | "issuedAt" | "total" | "securityCode" | "signedAt" | "buyerDocType" | "buyerDocNumber">,
  profile: StampProfile,
): Stamp | null {
  if (!doc.securityCode || !doc.signedAt || !doc.encf || !doc.issuedAt) return null;
  const buyerRnc = doc.buyerDocType === "RNC" || doc.buyerDocType === "CEDULA" ? doc.buyerDocNumber : null;
  return {
    securityCode: doc.securityCode,
    signedAt: doc.signedAt,
    qrUrl: stampUrl({
      env: profile.environment,
      type: doc.type as EcfType,
      sellerRnc: profile.rnc,
      buyerRnc,
      encf: doc.encf,
      issuedAt: doc.issuedAt,
      total: doc.total,
      signedAt: doc.signedAt,
      securityCode: doc.securityCode,
    }),
  };
}

