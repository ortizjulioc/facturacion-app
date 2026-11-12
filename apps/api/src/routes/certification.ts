import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
  buildEcfFromFields,
  buildFromFields,
  buildSummaryFromFields,
  EcfError,
  FiscalError,
  signEcf,
  signReply,
  signRfce,
  type FieldObject,
} from "@facturacion/ecf";
import { auditEntry } from "../lib/audit";
import { clientFor } from "../lib/fiscal";
import { loadSigner } from "../lib/signing";
import { zv } from "../lib/validator";
import { requireRole } from "../middleware/tenant";
import type { AppEnv } from "../types";

/**
 * Modo certificación: emite documentos que llegan campo por campo (el set de pruebas de la DGII), sin pasar por las
 * facturas del sistema. Arma el XML en el orden del XSD de su tipo, lo firma con el certificado de la empresa y, si se
 * pide, lo envía a la DGII del ambiente configurado (TesteCF o CerteCF). No guarda nada en el sistema: el número y los
 * datos son los del set.
 */

/** Umbral de la factura de consumo: por debajo se envía el resumen (RFCE) en vez del e-CF completo. */
const SUMMARY_LIMIT = 250_000;

const fieldsBody = z.object({
  /** Los campos con los nombres de la DGII, anidados como el XML (con o sin el elemento raíz). */
  fields: z.record(z.string(), z.unknown()),
  /** true: además de armarlo y firmarlo, lo envía a la DGII. */
  send: z.boolean().default(false),
});

const get = (o: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>((v, k) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>)[k] : undefined), o);

/** Problemas de estructura (uno por línea en el EcfError): se devuelven todos, como los errores de validación. */
class InvalidFields extends Error {
  constructor(readonly issues: string[]) {
    super(issues[0]);
  }
}
const invalid = (e: EcfError) => new InvalidFields(e.message.split("\n"));

/** Un fallo de la DGII: temporal (503) o un rechazo de la solicitud (422), con su motivo. */
const dgiiFailure = (e: FiscalError) => new HTTPException(e.retryable ? 503 : 422, { message: `DGII: ${e.message}` });

export const certification = new Hono<AppEnv>()
  .use(requireRole("owner", "admin"))
  .onError((err, c) => {
    if (err instanceof InvalidFields) return c.json({ error: err.message, issues: err.issues.map((message) => ({ path: [], message })) }, 422);
    throw err;
  })
  // Arma, firma y (opcionalmente) envía un e-CF del set. Una factura de consumo menor a RD$250,000 se envía como resumen.
  .post("/ecf", zv("json", fieldsBody), async (c) => {
    const { fields, send } = c.req.valid("json");
    const { env, fiscalFetch } = c.get("deps");
    const organizationId = c.get("organizationId");
    const { profile, cert } = await c.get("run")(async (tx) => ({
      profile: await tx.companyProfile.findFirst(),
      cert: await loadSigner(tx, env, organizationId),
    }));
    if (!profile) throw new HTTPException(422, { message: "Registra los datos fiscales de la empresa" });
    if (!cert) throw new HTTPException(422, { message: "Sube el certificado digital de la empresa" });

    let xml: string;
    try {
      xml = buildEcfFromFields(fields as FieldObject);
    } catch (e) {
      if (e instanceof EcfError) throw invalid(e);
      throw e;
    }
    const ecf = get(fields, "ECF") ?? fields;
    const type = String(get(ecf, "Encabezado", "IdDoc", "TipoeCF") ?? "");
    const encf = String(get(ecf, "Encabezado", "IdDoc", "eNCF") ?? "");
    const rnc = String(get(ecf, "Encabezado", "Emisor", "RNCEmisor") ?? profile.rnc);
    const total = Number(get(ecf, "Encabezado", "Totales", "MontoTotal") ?? 0);
    const kind = type === "32" && total < SUMMARY_LIMIT ? "RFCE" : "ECF";

    const signed = signEcf(xml, cert);
    let summaryXml: string | null = null;
    if (kind === "RFCE") {
      try {
        summaryXml = signRfce(buildSummaryFromFields(fields as FieldObject, signed.securityCode), cert);
      } catch (e) {
        if (e instanceof EcfError) throw invalid(e);
        throw e;
      }
    }

    let dgii: Record<string, unknown> | null = null;
    if (send) {
      const provider = clientFor(cert, profile.environment, fiscalFetch);
      try {
        dgii =
          kind === "RFCE"
            ? { ...(await provider.submitSummary({ xml: summaryXml!, rnc, encf })) }
            : { trackId: (await provider.submit({ xml: signed.xml, rnc, encf })).trackId };
      } catch (e) {
        if (e instanceof FiscalError) throw dgiiFailure(e);
        throw e;
      }
    }
    await c.get("run")((tx) => tx.auditLog.create({ data: auditEntry(c, "certification.ecf", "certification", encf, { type, kind, sent: send }) }));
    return c.json({
      data: { type, encf, kind, environment: profile.environment, securityCode: signed.securityCode, signedAt: signed.signedAt, xml: signed.xml, summaryXml, dgii },
    });
  })
  // Resultado de un e-CF enviado (por su TrackId).
  .get("/result/:trackId", async (c) => {
    const { env, fiscalFetch } = c.get("deps");
    const organizationId = c.get("organizationId");
    const { profile, cert } = await c.get("run")(async (tx) => ({
      profile: await tx.companyProfile.findFirst(),
      cert: await loadSigner(tx, env, organizationId),
    }));
    if (!profile || !cert) throw new HTTPException(422, { message: "Faltan los datos fiscales o el certificado" });
    try {
      return c.json({ data: await clientFor(cert, profile.environment, fiscalFetch).result(c.req.param("trackId")) });
    } catch (e) {
      if (e instanceof FiscalError) throw dgiiFailure(e);
      throw e;
    }
  })
  // Aprobación o rechazo comercial del set (ACECF): se arma, se firma y, si se pide, se entrega a la DGII.
  .post("/approval", zv("json", fieldsBody), async (c) => {
    const { fields, send } = c.req.valid("json");
    const { env, fiscalFetch } = c.get("deps");
    const organizationId = c.get("organizationId");
    const { profile, cert } = await c.get("run")(async (tx) => ({
      profile: await tx.companyProfile.findFirst(),
      cert: await loadSigner(tx, env, organizationId),
    }));
    if (!profile) throw new HTTPException(422, { message: "Registra los datos fiscales de la empresa" });
    if (!cert) throw new HTTPException(422, { message: "Sube el certificado digital de la empresa" });
    let xml: string;
    try {
      xml = signReply(buildFromFields("ACECF", fields as FieldObject), cert, "ACECF");
    } catch (e) {
      if (e instanceof EcfError) throw invalid(e);
      throw e;
    }
    const detail = get(fields, "ACECF", "DetalleAprobacionComercial") ?? get(fields, "DetalleAprobacionComercial");
    const encf = String(get(detail, "eNCF") ?? "");
    let dgii: Record<string, unknown> | null = null;
    if (send) {
      try {
        dgii = { ...(await clientFor(cert, profile.environment, fiscalFetch).submitApproval({ xml, rnc: profile.rnc, encf })) };
      } catch (e) {
        if (e instanceof FiscalError) throw dgiiFailure(e);
        throw e;
      }
    }
    await c.get("run")((tx) => tx.auditLog.create({ data: auditEntry(c, "certification.approval", "certification", encf, { sent: send }) }));
    return c.json({ data: { encf, xml, dgii } });
  });
