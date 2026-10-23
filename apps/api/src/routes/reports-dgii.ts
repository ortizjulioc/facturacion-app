import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { periodBounds, type FormatCode } from "@facturacion/core";
import { previewFormat } from "../lib/dgii-reports";
import { zv } from "../lib/validator";
import { requireRole } from "../middleware/tenant";
import type { AppEnv } from "../types";

const formatParam = z.object({ format: z.enum(["606", "607", "608"]).transform((v) => Number(v) as FormatCode) });
const periodQuery = z.object({
  period: z
    .string()
    .regex(/^\d{6}$/, "El período debe ser AAAAMM")
    .refine((p) => periodBounds(p) !== null, "El mes del período no es válido"),
});

/**
 * Formatos de envío de datos de la DGII: 606 (compras), 607 (ventas) y 608 (comprobantes anulados). La vista previa
 * muestra el contenido, los errores que impedirían enviarlo y los avisos; el archivo TXT solo se entrega sin errores.
 */
export const dgiiReports = new Hono<AppEnv>()
  .use("*", requireRole("owner", "admin"))
  .get("/dgii/:format", zv("param", formatParam), zv("query", periodQuery), async (c) => {
    const { format } = c.req.valid("param");
    const { period } = c.req.valid("query");
    const preview = await build(c, format, period);
    const { file: _file, ...data } = preview;
    return c.json({ data });
  })
  .get("/dgii/:format/file", zv("param", formatParam), zv("query", periodQuery), async (c) => {
    const { format } = c.req.valid("param");
    const { period } = c.req.valid("query");
    const preview = await build(c, format, period);
    if (!preview.ready) {
      return c.json({ error: `El formato ${format} tiene ${preview.errors.length} error(es): corrígelos antes de generar el archivo`, issues: preview.errors }, 422);
    }
    return new Response(preview.file.text, {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "content-disposition": `attachment; filename="${preview.file.filename}"`,
      },
    });
  });

async function build(c: Context<AppEnv>, format: FormatCode, period: string) {
  const profile = await c.get("db").companyProfile.findFirst({ select: { rnc: true } });
  if (!profile) throw new HTTPException(409, { message: "Configura primero los datos fiscales de la empresa (RNC)" });
  const preview = await c.get("run")((tx) => previewFormat(tx, format, profile.rnc, period));
  if (!preview) throw new HTTPException(400, { message: "Período inválido" });
  return preview;
}
