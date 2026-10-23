import { fromCents } from "@facturacion/core";
import { Prisma, tenantTransaction, type DbClient } from "@facturacion/db";
import {
  buildAcecf,
  buildArecf,
  FiscalError,
  inspectIncomingApproval,
  inspectIncomingEcf,
  PeerClient,
  signReply,
  type NotReceivedReason,
} from "@facturacion/ecf";
import { clientFor, type FiscalDeps } from "./fiscal";
import { loadSigner } from "./signing";

/** Tamaño máximo de un XML recibido (un e-CF con muchas líneas pesa unos cientos de KB). */
export const MAX_XML_BYTES = 5_000_000;

const later = (now: Date, seconds: number) => new Date(now.getTime() + seconds * 1000);
const iso = (d: Date) => d.toISOString();

/** Esperas (segundos) entre reintentos de entrega de una aprobación; la última se repite. */
export const APPROVAL_BACKOFF_SECONDS = [30, 120, 600, 1_800, 3_600];
export const MAX_APPROVAL_ATTEMPTS = 20;
const LOCK_SECONDS = 120;

// ───────────── Encontrar la empresa ─────────────

/**
 * La empresa que tiene ese RNC, para los servicios públicos que reciben un documento sin sesión. Solo lee los datos
 * fiscales (política `receiver_lookup`). null si no hay ninguna o hay más de una (no se puede saber de quién es).
 */
export async function organizationByRnc(prisma: DbClient, rnc: string): Promise<{ organizationId: string; requireAuth: boolean } | null> {
  const rows = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.system', 'receiver', TRUE)`;
    return tx.companyProfile.findMany({ where: { rnc }, select: { organizationId: true, requireReceiverAuth: true }, take: 2 });
  });
  return rows.length === 1 ? { organizationId: rows[0]!.organizationId, requireAuth: rows[0]!.requireReceiverAuth } : null;
}

/** Quien llama a un servicio público: si se autenticó (token válido) y con qué RNC (el de su certificado). */
export type Caller = { authenticated: boolean; rnc: string | null };
export const ANONYMOUS: Caller = { authenticated: false, rnc: null };

/** XML con una declaración DOCTYPE o ENTITY: se rechaza sin leerlo (expansión de entidades, entidades externas). */
export const isUnsafeXml = (xml: string) => /<!DOCTYPE|<!ENTITY/i.test(xml);

/** «dd-MM-AAAA» → fecha (a medianoche UTC, para guardarla como DATE). */
export function parseDmy(s: string): Date {
  const [d, m, y] = s.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d));
}
export const formatDmyUtc = (d: Date) =>
  `${String(d.getUTCDate()).padStart(2, "0")}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${d.getUTCFullYear()}`;

// ───────────── Recibir un e-CF (servicio público) ─────────────

export type ReceiveOutcome = { status: number; xml: string } | { status: number; error: string };

/**
 * Servicio de recepción: otro contribuyente (o la DGII) nos manda un e-CF y espera, en la misma respuesta, el acuse
 * de recibo firmado. Si el comprobante no se puede dar por recibido se contesta igual, con el motivo; solo cuando ni
 * siquiera se puede saber de quién es (o la empresa no tiene certificado para firmar el acuse) la respuesta es un error HTTP.
 */
export async function receiveEcf(deps: FiscalDeps, xml: string, now: Date = new Date(), caller: Caller = ANONYMOUS): Promise<ReceiveOutcome> {
  if (Buffer.byteLength(xml) > MAX_XML_BYTES) return { status: 400, error: "Archivo no válido: es demasiado grande" };
  if (isUnsafeXml(xml)) return { status: 400, error: "Archivo no válido: no se admiten declaraciones DOCTYPE ni ENTITY" };
  const inspection = inspectIncomingEcf(xml);
  const read = inspection.ok
    ? { sellerRnc: inspection.facts.sellerRnc, buyerRnc: inspection.facts.buyerRnc, encf: inspection.facts.encf }
    : inspection.partial;
  if (!read.buyerRnc) return { status: 400, error: "No se pudo identificar al comprador del e-CF" };
  if (!read.sellerRnc || !read.encf) return { status: 400, error: "La estructura del archivo XML no es válida" };

  const target = await organizationByRnc(deps.prisma, read.buyerRnc);
  if (!target) return { status: 400, error: "El RNC del comprador no corresponde a ninguna empresa de este sistema" };
  const { organizationId } = target;
  if (target.requireAuth && !caller.authenticated) {
    return { status: 401, error: "Este receptor exige autenticación: pide una semilla, fírmala con tu certificado y cámbiala por un token" };
  }
  // Quien se autentica solo puede enviar sus propios comprobantes: el RNC de su certificado es el del emisor.
  if (caller.authenticated && caller.rnc !== read.sellerRnc) {
    return { status: 403, error: "El certificado con el que te autenticaste no corresponde al emisor del e-CF" };
  }

  return tenantTransaction(deps.prisma, organizationId, async (tx): Promise<ReceiveOutcome> => {
    const cert = await loadSigner(tx, deps.env, organizationId);
    if (!cert) return { status: 503, error: "La empresa receptora aún no puede responder acuses: falta su certificado digital" };

    const ack = (reason: NotReceivedReason | null) =>
      signReply(buildArecf({ sellerRnc: read.sellerRnc!, buyerRnc: read.buyerRnc!, encf: read.encf!, reason, at: now }), cert, "ARECF", now);

    if (!inspection.ok) return { status: 200, xml: ack(1) };
    if (!inspection.signatureValid) return { status: 200, xml: ack(2) };
    const f = inspection.facts;
    const duplicate = await tx.receivedDocument.findFirst({ where: { emitterRnc: f.sellerRnc, encf: f.encf }, select: { id: true } });
    if (duplicate) return { status: 200, xml: ack(3) };

    const ackXml = ack(null);
    try {
      const row = await tx.receivedDocument.create({
        data: {
          organizationId,
          emitterRnc: f.sellerRnc,
          emitterName: f.sellerName,
          ecfType: f.type,
          encf: f.encf,
          issuedOn: parseDmy(f.issuedOn),
          total: f.total,
          totalItbis: f.totalItbis,
          xml,
          signatureValid: true,
          securityCode: f.securityCode,
          signedAtText: f.signedAt,
          receivedAt: now,
          ackXml,
        },
      });
      await tx.auditLog.create({
        data: { organizationId, action: "receiver.receive", entity: "received_document", entityId: row.id, data: { emitterRnc: f.sellerRnc, encf: f.encf, total: fromCents(f.total) } },
      });
    } catch (e) {
      // Dos envíos simultáneos del mismo e-CF: el segundo choca con el índice único.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return { status: 200, xml: ack(3) };
      throw e;
    }
    return { status: 200, xml: ackXml };
  });
}

// ───────────── Decidir (aprobar o rechazar) ─────────────

export class ReceiverError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 409 | 422,
  ) {
    super(message);
  }
}

/** Tipos para los que la DGII no pide aprobación comercial (la factura de consumo). */
const NO_APPROVAL_TYPES = new Set(["32"]);

/** El comprador aprueba o rechaza un e-CF recibido: se arma y firma el ACECF y queda pendiente de entregar. */
export async function decide(
  deps: FiscalDeps,
  organizationId: string,
  id: string,
  decision: { approved: boolean; reason?: string | null; userId: string },
  now: Date = new Date(),
) {
  await tenantTransaction(deps.prisma, organizationId, async (tx) => {
    const row = await tx.receivedDocument.findFirst({ where: { id } });
    if (!row) throw new ReceiverError("Comprobante recibido no encontrado", 404);
    if (row.approved !== null) throw new ReceiverError("Ya registraste tu decisión sobre este comprobante", 409);
    if (NO_APPROVAL_TYPES.has(row.ecfType)) throw new ReceiverError("La aprobación comercial no es requerida para este tipo de e-CF", 422);
    if (decision.approved && !row.signatureValid) throw new ReceiverError("No se puede aprobar un comprobante con la firma inválida", 422);
    if (!decision.approved && !decision.reason?.trim()) throw new ReceiverError("Indica el motivo del rechazo", 422);

    const profile = await tx.companyProfile.findFirst({ select: { rnc: true } });
    const cert = await loadSigner(tx, deps.env, organizationId);
    if (!profile || !cert) throw new ReceiverError("Para responder necesitas los datos fiscales y el certificado digital de la empresa", 422);

    const xml = signReply(
      buildAcecf({
        sellerRnc: row.emitterRnc,
        buyerRnc: profile.rnc,
        encf: row.encf,
        issuedOn: formatDmyUtc(row.issuedOn),
        total: row.total,
        approved: decision.approved,
        rejectReason: decision.reason ?? null,
        at: now,
      }),
      cert,
      "ACECF",
      now,
    );
    await tx.receivedDocument.update({
      where: { id },
      data: {
        approved: decision.approved,
        approvalReason: decision.approved ? null : decision.reason!.trim(),
        decidedAt: now,
        decidedById: decision.userId,
        approvalXml: xml,
        approvalState: "PENDING",
        approvalAttempts: 0,
        approvalNextAt: now,
        approvalLockedUntil: null,
        peerError: null,
        dgiiError: null,
      },
    });
    await tx.auditLog.create({
      data: { organizationId, actorUserId: decision.userId, action: decision.approved ? "receiver.approve" : "receiver.reject", entity: "received_document", entityId: id, data: { encf: row.encf } },
    });
  });
  return deliverApproval(deps, organizationId, id, now);
}

/** Vuelve a poner en cola la entrega de una aprobación que falló. */
export async function resendApproval(deps: FiscalDeps, organizationId: string, id: string, now: Date = new Date()) {
  const ok = await tenantTransaction(deps.prisma, organizationId, async (tx) => {
    const { count } = await tx.receivedDocument.updateMany({
      where: { id, approvalState: "FAILED" },
      data: { approvalState: "PENDING", approvalAttempts: 0, approvalNextAt: now, approvalLockedUntil: null },
    });
    return count > 0;
  });
  if (!ok) throw new ReceiverError("Solo se puede reintentar una aprobación cuya entrega falló", 409);
  return deliverApproval(deps, organizationId, id, now);
}

// ───────────── Entregar la aprobación ─────────────

type Leg = { done: true } | { done: false; retry: boolean; error: string };

const legError = (e: unknown): Leg => {
  if (e instanceof FiscalError) return { done: false, retry: e.retryable, error: e.message };
  throw e;
};

/**
 * Entrega la aprobación al emisor (su servicio de aprobación comercial, según el directorio de la DGII) y la copia a la
 * DGII. Cada destino se intenta por separado y se recuerda cuál ya se entregó, así un reintento solo repite lo que falta.
 * Los fallos temporales se reintentan con espera; los definitivos dejan la entrega en FAILED con el motivo.
 */
export async function deliverApproval(deps: FiscalDeps, organizationId: string, id: string, now: Date = new Date()) {
  const loaded = await tenantTransaction(deps.prisma, organizationId, async (tx) => ({
    row: await tx.receivedDocument.findFirst({ where: { id } }),
    profile: await tx.companyProfile.findFirst({ select: { rnc: true, environment: true } }),
    cert: await loadSigner(tx, deps.env, organizationId),
  }));
  const { row, profile, cert } = loaded;
  if (!row || row.approvalState !== "PENDING" || !row.approvalXml) return row;

  const finish = (data: Prisma.ReceivedDocumentUncheckedUpdateInput) =>
    tenantTransaction(deps.prisma, organizationId, (tx) => tx.receivedDocument.update({ where: { id }, data: { ...data, approvalLockedUntil: null } }));

  if (!profile || !cert) return finish({ approvalState: "FAILED", peerError: "Falta el certificado digital de la empresa" });

  const provider = clientFor(cert, profile.environment, deps.fetch);
  const xml = row.approvalXml;

  const peerLeg = async (): Promise<Leg> => {
    if (row.peerSentAt) return { done: true };
    try {
      const entry = await provider.directoryOf(row.emitterRnc);
      if (!entry) return { done: false, retry: false, error: "El emisor no aparece en el directorio de contribuyentes electrónicos de la DGII" };
      await new PeerClient({ certificate: cert, ...(deps.fetch ? { fetch: deps.fetch } : {}) }).sendApproval(entry, xml, profile.rnc, row.encf);
      return { done: true };
    } catch (e) {
      return legError(e);
    }
  };
  const dgiiLeg = async (): Promise<Leg> => {
    if (row.dgiiSentAt) return { done: true };
    try {
      const r = await provider.submitApproval({ xml, rnc: profile.rnc, encf: row.encf });
      return r.approved ? { done: true } : { done: false, retry: false, error: r.messages.join(" · ") || r.status || "La DGII no aceptó la aprobación" };
    } catch (e) {
      return legError(e);
    }
  };
  const [peer, dgii] = await Promise.all([peerLeg(), dgiiLeg()]);

  const attempts = row.approvalAttempts + 1;
  const data: Prisma.ReceivedDocumentUncheckedUpdateInput = {
    approvalAttempts: attempts,
    ...(peer.done ? { peerSentAt: row.peerSentAt ?? now, peerError: null } : { peerError: peer.error }),
    ...(dgii.done ? { dgiiSentAt: row.dgiiSentAt ?? now, dgiiError: null } : { dgiiError: dgii.error }),
  };
  if (peer.done && dgii.done) return finish({ ...data, approvalState: "SENT" });
  const failed = [peer, dgii].filter((l): l is Extract<Leg, { done: false }> => !l.done);
  if (failed.some((l) => !l.retry) || attempts >= MAX_APPROVAL_ATTEMPTS) return finish({ ...data, approvalState: "FAILED" });
  return finish({ ...data, approvalNextAt: later(now, APPROVAL_BACKOFF_SECONDS[Math.min(attempts - 1, APPROVAL_BACKOFF_SECONDS.length - 1)]!) });
}

/** Entrega lo que ya toca (todas las empresas): lo llama el trabajador del servidor. Nunca lanza. */
export async function processApprovals(deps: FiscalDeps, now: Date = new Date(), limit = 20): Promise<number> {
  const until = later(now, LOCK_SECONDS);
  const rows = await deps.prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.system', 'fiscal-worker', TRUE)`;
    return tx.$queryRaw<{ id: string; organizationId: string }[]>`
      UPDATE "received_document" SET "approvalLockedUntil" = ${iso(until)}::timestamp, "updatedAt" = now()
      WHERE "id" IN (
        SELECT "id" FROM "received_document"
        WHERE "approvalState" = 'PENDING'::"ApprovalState"
          AND "approvalNextAt" <= ${iso(now)}::timestamp
          AND ("approvalLockedUntil" IS NULL OR "approvalLockedUntil" < ${iso(now)}::timestamp)
        ORDER BY "approvalNextAt"
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING "id", "organizationId"`;
  });
  for (const r of rows) {
    await deliverApproval(deps, r.organizationId, r.id, now).catch((err) => {
      deps.logger.error({ err, receivedId: r.id }, "fallo entregando una aprobación comercial");
    });
  }
  return rows.length;
}

// ───────────── Aprobaciones que nos envían nuestros clientes ─────────────

export type ApprovalReceipt = { status: number; body: { mensaje: string[]; estado: string; codigo: string } };

const refused = (message: string): ApprovalReceipt => ({ status: 400, body: { mensaje: [message], estado: "Aprobación comercial rechazada", codigo: "2" } });

/**
 * Servicio de aprobación comercial: un cliente al que le emitimos un e-CF nos manda su aprobación o rechazo. Se guarda
 * junto al comprobante (que sigue congelado). Mensajes y códigos según «Descripción Técnica Servicios DGII».
 */
export async function receiveApproval(deps: FiscalDeps, xml: string, now: Date = new Date(), caller: Caller = ANONYMOUS): Promise<ApprovalReceipt> {
  if (Buffer.byteLength(xml) > MAX_XML_BYTES || isUnsafeXml(xml)) return refused("Archivo no válido");
  const r = inspectIncomingApproval(xml);
  if (!r.ok) return refused(r.error.startsWith("La estructura") ? r.error : "Tipo de archivo no válido, favor proveer un XML");
  if (!r.signatureValid) return refused("La firma del XML no es válida");
  const f = r.facts;
  const target = await organizationByRnc(deps.prisma, f.sellerRnc);
  if (!target) return refused("No se encuentra un e-CF válido para esta aprobación comercial");
  const { organizationId } = target;
  if (target.requireAuth && !caller.authenticated) {
    return { status: 401, body: { mensaje: ["Este receptor exige autenticación"], estado: "Aprobación comercial rechazada", codigo: "2" } };
  }
  // Quien se autentica solo puede responder por sí mismo: el RNC de su certificado es el del comprador.
  if (caller.authenticated && caller.rnc !== f.buyerRnc) {
    return { status: 403, body: { mensaje: ["El certificado con el que te autenticaste no corresponde al comprador"], estado: "Aprobación comercial rechazada", codigo: "2" } };
  }

  return tenantTransaction(deps.prisma, organizationId, async (tx): Promise<ApprovalReceipt> => {
    const doc = await tx.document.findFirst({ where: { encf: f.encf, status: { not: "DRAFT" } }, select: { id: true, type: true, total: true, buyerDocNumber: true } });
    if (!doc) return refused("Factura no encontrada para esta Aprobación comercial.");
    if (doc.type === "E32") return refused("Aprobación Comercial no es requerida para este tipo de e-CF");
    if (doc.total !== f.total || (doc.buyerDocNumber ?? "") !== f.buyerRnc) return refused("No se encuentra un e-CF válido para esta aprobación comercial");
    const data = { approved: f.approved, reason: f.rejectReason, approvedAtText: f.approvedAt, signatureValid: true, xml, receivedAt: now };
    await tx.issuedApproval.upsert({ where: { documentId: doc.id }, create: { organizationId, documentId: doc.id, ...data }, update: data });
    await tx.auditLog.create({
      data: { organizationId, action: "receiver.approval_in", entity: "document", entityId: doc.id, data: { encf: f.encf, approved: f.approved } },
    });
    return { status: 200, body: { mensaje: ["Aprobación comercial recibida"], estado: "Aprobación comercial aprobada", codigo: "1" } };
  });
}

