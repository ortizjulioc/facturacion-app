import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { normalizeDocument } from "@facturacion/core";
import { auditEntry } from "../lib/audit";
import { optionalText } from "../lib/schemas";
import { certificateInfo, saveCertificate } from "../lib/signing";
import { zv } from "../lib/validator";
import { requireRole } from "../middleware/tenant";
import type { AppEnv } from "../types";

const companyInput = z.object({
  rnc: z.string().trim().min(1),
  legalName: z.string().trim().min(2).max(200),
  tradeName: optionalText(200),
  address: z.string().trim().min(3).max(250),
  province: optionalText(100),
  municipality: optionalText(100),
  economicActivity: optionalText(200),
  email: z.email("Correo inválido").max(200).nullish(),
  phone: optionalText(30),
  environment: z.enum(["TEST", "CERT", "PROD"]),
  /** Exigir un turno abierto para vender desde una caja. */
  requireShift: z.boolean().optional(),
});

/** El .p12 viaja en base64 dentro del JSON (pesa unos pocos KB). */
const certificateInput = z.object({
  p12: z.string().min(100).max(200_000),
  password: z.string().min(1).max(200),
});

export const company = new Hono<AppEnv>()
  // null si la empresa aún no registró sus datos fiscales.
  .get("/", async (c) => {
    const data = await c.get("db").companyProfile.findFirst();
    return c.json({ data });
  })
  // Certificado digital con el que se firman los e-CF: solo se devuelven sus datos públicos.
  .get("/certificate", requireRole("owner", "admin"), async (c) => {
    const data = await c.get("run")((tx) => certificateInfo(tx));
    return c.json({ data });
  })
  .put("/certificate", requireRole("owner", "admin"), zv("json", certificateInput), async (c) => {
    const { p12, password } = c.req.valid("json");
    const bytes = Buffer.from(p12, "base64");
    if (bytes.length < 100) throw new HTTPException(422, { message: "El archivo del certificado no es válido" });
    const data = await c.get("run")(async (tx) => {
      const profile = await tx.companyProfile.findFirst({ select: { id: true } });
      if (!profile) throw new HTTPException(422, { message: "Registra primero los datos fiscales de la empresa" });
      const info = await saveCertificate(tx, c.get("deps").env, {
        organizationId: c.get("organizationId"),
        userId: c.get("user").id,
        p12: bytes,
        password,
      });
      await tx.auditLog.create({
        data: auditEntry(c, "company.certificate", "company_profile", profile.id, { subject: info.subject, notAfter: info.notAfter }),
      });
      return info;
    });
    return c.json({ data });
  })
  .delete("/certificate", requireRole("owner", "admin"), async (c) => {
    await c.get("run")(async (tx) => {
      const { count } = await tx.companyCertificate.deleteMany({});
      if (count === 0) throw new HTTPException(404, { message: "No hay un certificado cargado" });
      await tx.auditLog.create({ data: auditEntry(c, "company.certificate_delete", "company_profile", c.get("organizationId")) });
    });
    return c.body(null, 204);
  })
  .put("/", requireRole("owner", "admin"), zv("json", companyInput), async (c) => {
    const input = c.req.valid("json");
    const rnc = normalizeDocument("RNC", input.rnc);
    if (!rnc.ok) throw new HTTPException(422, { message: rnc.error });

    const values = { ...input, rnc: rnc.value, email: input.email ?? null };
    const organizationId = c.get("organizationId");
    const data = await c.get("run")(async (tx) => {
      const saved = await tx.companyProfile.upsert({
        where: { organizationId },
        create: { ...values, organizationId },
        update: values,
      });
      await tx.auditLog.create({
        data: auditEntry(c, "company.update", "company_profile", saved.id, {
          rnc: saved.rnc,
          environment: saved.environment,
        }),
      });
      return saved;
    });
    return c.json({ data });
  });
