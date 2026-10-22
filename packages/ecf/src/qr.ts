import { CONSUMER_ID_THRESHOLD, fromCents, type Cents, type EcfType } from "@facturacion/core";
import { formatDate, formatDateTime } from "./format";
import type { EcfEnvironment } from "./types";

/** Ruta de cada ambiente en los servicios de la DGII. */
export const ENVIRONMENT_PATH: Record<EcfEnvironment, string> = {
  TEST: "testecf",
  CERT: "certecf",
  PROD: "ecf",
};

export const ECF_HOST = "https://ecf.dgii.gov.do";
/** Las facturas de consumo menores a RD$250,000 tienen su propio dominio (resumen RFCE). */
export const FC_HOST = "https://fc.dgii.gov.do";

/** URLs base de los servicios de la DGII para un ambiente. */
export function serviceUrls(env: EcfEnvironment) {
  const path = ENVIRONMENT_PATH[env];
  return {
    authentication: `${ECF_HOST}/${path}/autenticacion`,
    reception: `${ECF_HOST}/${path}/recepcion`,
    summaryReception: `${FC_HOST}/${path}/recepcionfc`,
    approval: `${ECF_HOST}/${path}/aprobacioncomercial`,
    directory: `${ECF_HOST}/${path}/consultadirectorio`,
    summaryQuery: `${FC_HOST}/${path}/consultarfce`,
    result: `${ECF_HOST}/${path}/consultaresultado`,
    trackIds: `${ECF_HOST}/${path}/consultatrackids`,
    stampQuery: `${ECF_HOST}/${path}/consultatimbre`,
    summaryStampQuery: `${FC_HOST}/${path}/consultatimbrefc`,
  };
}

export type StampData = {
  env: EcfEnvironment;
  type: EcfType;
  sellerRnc: string;
  buyerRnc?: string | null;
  encf: string;
  issuedAt: Date;
  total: Cents;
  signedAt: Date;
  securityCode: string;
};

/**
 * Codifica un valor para la URL del timbre. Además de lo que escapa `encodeURIComponent`, la DGII exige
 * escapar `! ' ( ) *`: el código de seguridad sale de un Base64 y puede traer `+` y `/`.
 */
const encode = (value: string) =>
  encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** ¿Esta factura de consumo va por el resumen (RFCE) en vez del e-CF completo? */
export const isSummaryInvoice = (type: EcfType, total: Cents) => type === "E32" && total < CONSUMER_ID_THRESHOLD;

/**
 * Dirección que lleva el código QR de la representación impresa. Las facturas de consumo menores a
 * RD$250,000 usan la consulta del resumen (con menos datos); el resto, la consulta de timbre completa.
 */
export function stampUrl(d: StampData): string {
  const urls = serviceUrls(d.env);
  if (isSummaryInvoice(d.type, d.total)) {
    const query = [
      `rncemisor=${encode(d.sellerRnc)}`,
      `encf=${encode(d.encf)}`,
      `montototal=${fromCents(d.total)}`,
      `codigoseguridad=${encode(d.securityCode)}`,
    ];
    return `${urls.summaryStampQuery}?${query.join("&")}`;
  }
  const query = [
    `rncemisor=${encode(d.sellerRnc)}`,
    ...(d.buyerRnc ? [`rnccomprador=${encode(d.buyerRnc)}`] : []),
    `encf=${encode(d.encf)}`,
    `fechaemision=${formatDate(d.issuedAt)}`,
    `montototal=${fromCents(d.total)}`,
    `fechafirma=${formatDateTime(d.signedAt).replace(" ", "%20")}`,
    `codigoseguridad=${encode(d.securityCode)}`,
  ];
  return `${urls.stampQuery}?${query.join("&")}`;
}
