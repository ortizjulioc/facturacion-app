/**
 * Documentos de identidad del comprador/vendedor.
 *
 * Solo valida FORMATO (longitud y caracteres). No verifica el dígito de control: la DGII tiene
 * RNC antiguos que no lo cumplen; la existencia real se comprobará contra el padrón de la DGII.
 */
export const DOCUMENT_TYPES = ["RNC", "CEDULA", "PASAPORTE"] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export type NormalizedDocument = { ok: true; value: string } | { ok: false; error: string };

export function normalizeDocument(type: DocumentType, raw: string): NormalizedDocument {
  switch (type) {
    case "RNC": {
      const digits = raw.replace(/[\s-]/g, "");
      return /^\d{9}$/.test(digits)
        ? { ok: true, value: digits }
        : { ok: false, error: "El RNC debe tener 9 dígitos" };
    }
    case "CEDULA": {
      const digits = raw.replace(/[\s-]/g, "");
      return /^\d{11}$/.test(digits)
        ? { ok: true, value: digits }
        : { ok: false, error: "La cédula debe tener 11 dígitos" };
    }
    case "PASAPORTE": {
      const value = raw.replace(/\s/g, "").toUpperCase();
      return /^[A-Z0-9]{5,20}$/.test(value)
        ? { ok: true, value }
        : { ok: false, error: "El pasaporte debe tener entre 5 y 20 letras o números" };
    }
  }
}

/** "101001577" → "1-01-00157-7"; "00112345678" → "001-1234567-8". Otros valores quedan igual. */
export function formatDocument(type: DocumentType, value: string): string {
  if (type === "RNC" && /^\d{9}$/.test(value)) {
    return `${value[0]}-${value.slice(1, 3)}-${value.slice(3, 8)}-${value[8]}`;
  }
  if (type === "CEDULA" && /^\d{11}$/.test(value)) {
    return `${value.slice(0, 3)}-${value.slice(3, 10)}-${value[10]}`;
  }
  return value;
}
