import { CONSUMER_ID_THRESHOLD } from "@facturacion/core";
import type { TenantTx } from "../types";

/**
 * ¿Por qué este comprobante no se puede enviar (todavía)? null = se puede.
 * Las facturas de consumo menores a RD$250,000 no van por la recepción de e-CF sino por un resumen (RFCE) que aún no
 * está implementado.
 */
export function fiscalBlock(doc: { type: string; total: bigint; currency: string; ecfXml: string | null; status: string }): string | null {
  if (doc.status === "DRAFT") return "El comprobante aún no está emitido";
  if (!doc.ecfXml) return "El comprobante no está firmado: sube el certificado digital y fírmalo primero";
  if (doc.type === "E32" && doc.total < CONSUMER_ID_THRESHOLD) {
    return "Las facturas de consumo menores a RD$250,000 se reportan con un resumen (RFCE), que aún no está disponible";
  }
  return null;
}

/** Pone el comprobante en la cola de envío (no hace nada si ya está). Devuelve true si lo agregó. */
export async function enqueueSubmission(tx: TenantTx, organizationId: string, documentId: string): Promise<boolean> {
  const existing = await tx.fiscalSubmission.findFirst({ where: { documentId }, select: { id: true } });
  if (existing) return false;
  await tx.fiscalSubmission.create({ data: { organizationId, documentId } });
  return true;
}

/** Si la empresa envía sola a la DGII y el comprobante se puede enviar, lo encola. */
export async function enqueueIfAuto(
  tx: TenantTx,
  organizationId: string,
  doc: { id: string; type: string; total: bigint; currency: string; ecfXml: string | null; status: string },
  profile: { sendToDgii: boolean },
): Promise<boolean> {
  return profile.sendToDgii && !fiscalBlock(doc) ? enqueueSubmission(tx, organizationId, doc.id) : false;
}

/**
 * Vuelve a poner en la cola un envío que falló (después de corregir la causa, p. ej. subir otro certificado).
 * Si ya tenía TrackId solo se retoma la consulta del resultado; si no, se vuelve a enviar.
 */
export async function retrySubmission(tx: TenantTx, documentId: string): Promise<boolean> {
  const base = { attempts: 0, lastError: null, lockedUntil: null, nextAttemptAt: new Date(), finishedAt: null };
  const resumed = await tx.fiscalSubmission.updateMany({ where: { documentId, state: "FAILED", trackId: { not: null } }, data: { ...base, state: "SENT" } });
  const resent = await tx.fiscalSubmission.updateMany({ where: { documentId, state: "FAILED", trackId: null }, data: { ...base, state: "PENDING" } });
  return resumed.count + resent.count > 0;
}
