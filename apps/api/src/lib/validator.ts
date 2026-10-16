import { zValidator } from "@hono/zod-validator";
import type { ValidationTargets } from "hono";
import type { ZodType } from "zod";

/**
 * zValidator con respuesta uniforme: `{ error: "primer mensaje", issues: [{ path, message }] }`.
 * Los clientes pueden mostrar `error` directamente y resaltar campos con `issues`.
 */
export const zv = <T extends ZodType, Target extends keyof ValidationTargets>(
  target: Target,
  schema: T,
) =>
  zValidator(target, schema, (result, c) => {
    if (!result.success) {
      return c.json(
        {
          error: result.error.issues[0]?.message ?? "Datos inválidos",
          issues: result.error.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
          })),
        },
        400,
      );
    }
  });
