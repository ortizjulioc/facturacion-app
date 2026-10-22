import type { EcfSeller } from "./types";

/** Datos fiscales de la empresa tal como los guarda la aplicación (la nube y la caja). */
export type CompanyData = {
  rnc: string;
  legalName: string;
  tradeName: string | null;
  address: string;
  province: string | null;
  municipality: string | null;
  economicActivity: string | null;
  email: string | null;
  phone: string | null;
};

/** Teléfono en el formato xxx-xxx-xxxx de la DGII, o null si no tiene 10 dígitos. */
export function phoneOf(raw: string | null): string | null {
  const digits = (raw ?? "").replace(/\D/g, "");
  const local = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return local.length === 10 ? `${local.slice(0, 3)}-${local.slice(3, 6)}-${local.slice(6)}` : null;
}

const codeOf = (v: string | null) => (v && /^\d{6}$/.test(v.trim()) ? v.trim() : null);

/** El emisor del e-CF a partir de los datos de la empresa: la nube y la caja arman lo mismo. */
export function sellerOf(c: CompanyData): EcfSeller {
  const phone = phoneOf(c.phone);
  return {
    rnc: c.rnc,
    legalName: c.legalName,
    tradeName: c.tradeName,
    address: c.address,
    municipalityCode: codeOf(c.municipality),
    provinceCode: codeOf(c.province),
    phones: phone ? [phone] : [],
    email: c.email,
    economicActivity: c.economicActivity,
  };
}
