import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { normalizeDocument } from "@facturacion/core";
import { auditEntry } from "../lib/audit";
import { optionalText } from "../lib/schemas";
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

export const company = new Hono<AppEnv>()
  // null si la empresa aún no registró sus datos fiscales.
  .get("/", async (c) => {
    const data = await c.get("db").companyProfile.findFirst();
    return c.json({ data });
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
