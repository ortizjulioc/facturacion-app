import { z } from "zod";

export const uuidParam = z.object({ id: z.uuid("Identificador inválido") });

/** Monto en pesos como texto: "19.99". Se convierte a centavos con `toCents`. */
export const money = z
  .string()
  .trim()
  .regex(/^\d{1,12}(\.\d{1,2})?$/, "Monto inválido, usa el formato 19.99");

/** Cantidad con hasta 3 decimales: "1", "2.5", "0.125". */
export const quantity = z
  .string()
  .trim()
  .regex(/^\d{1,9}(\.\d{1,3})?$/, "Cantidad inválida, máximo 3 decimales");

export const listQuery = z.object({
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  active: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
});

export type Page<T> = { data: T[]; total: number; page: number; pageSize: number };

export const pageOf = <T>(
  data: T[],
  total: number,
  page: number,
  pageSize: number,
): Page<T> => ({
  data,
  total,
  page,
  pageSize,
});

/** Texto opcional: cadena vacía o null limpian el campo. */
export const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));

export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha inválida (AAAA-MM-DD)");
