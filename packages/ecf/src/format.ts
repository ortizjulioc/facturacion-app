import { fromCents, type Cents, type Milli } from "@facturacion/core";
import { EcfError } from "./types";

/** La DGII trabaja en hora de Santo Domingo (GMT-4, sin horario de verano). */
const RD_OFFSET_MS = 4 * 60 * 60 * 1000;
const pad = (n: number) => String(n).padStart(2, "0");

/** Hora de República Dominicana: los getters UTC del resultado dan la hora local. */
const inRd = (date: Date) => new Date(date.getTime() - RD_OFFSET_MS);

/** «dd-MM-AAAA» en hora dominicana. */
export function formatDate(date: Date): string {
  const d = inRd(date);
  return `${pad(d.getUTCDate())}-${pad(d.getUTCMonth() + 1)}-${d.getUTCFullYear()}`;
}

/** «dd-MM-AAAA HH:mm:ss» en hora dominicana (FechaHoraFirma y FechaFirma del QR). */
export function formatDateTime(date: Date): string {
  const d = inRd(date);
  return `${formatDate(date)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/** «AAAA-MM-DD» (fecha sin hora, p. ej. el vencimiento de la secuencia) → «dd-MM-AAAA». */
export function formatDateOnly(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new EcfError(`Fecha inválida: "${iso}" (se esperaba AAAA-MM-DD)`);
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/** Monto con 2 decimales y punto, sin separador de miles. */
export const formatAmount = (cents: Cents): string => fromCents(cents);

/**
 * Cantidad con 2 decimales (el e-CF no admite más). Una cantidad con milésimas, como 1.250 kg,
 * no se puede expresar: se rechaza en vez de redondear y descuadrar el monto de la línea.
 */
export function formatQuantity(quantity: Milli): string {
  if (quantity <= 0n) throw new EcfError("La cantidad de una línea debe ser mayor que cero");
  if (quantity % 10n !== 0n) {
    throw new EcfError("El e-CF admite cantidades de hasta 2 decimales; una línea tiene 3");
  }
  return fromCents(quantity / 10n);
}

/** Precio unitario: la DGII admite hasta 4 decimales; se envían 2 si los otros dos son cero. */
export const formatUnitPrice = (cents: Cents): string => fromCents(cents);

/**
 * Quita la declaración XML y el espacio en blanco entre etiquetas. La DGII firma y valida sin preservar espacios
 * (`preserveWhitespace = false`): un documento recibido con sangrías, como la semilla, se compacta ANTES de firmarlo.
 */
export const compactXml = (xml: string): string => xml.replace(/^\s*<\?xml[^>]*\?>\s*/, "").replace(/>\s+</g, "><").trim();

const XML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

/** Escapa los cinco caracteres que el XML de la DGII exige escapar. */
export const escapeXml = (text: string): string => text.replace(/[&<>"']/g, (c) => XML_ESCAPES[c]!);

/** Caracteres de control no permitidos en XML 1.0 (se descartan en vez de romper el documento). */
const INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

/** Texto para un campo del e-CF: sin controles, sin espacios sobrantes, recortado al máximo. */
export function clean(text: string, max: number): string {
  return text.replace(INVALID_XML_CHARS, "").replace(/\s+/g, " ").trim().slice(0, max);
}

export type XmlNode = { name: string; children: (XmlNode | null | undefined)[] } | { name: string; text: string };

/** Elemento con texto; se omite (null) cuando no hay valor: la DGII no admite etiquetas vacías. */
export function leaf(name: string, value: string | number | null | undefined): XmlNode | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text === "" ? null : { name, text };
}

/** Elemento con hijos; se omite si todos sus hijos se omiten. */
export function node(name: string, ...children: (XmlNode | null | undefined)[]): XmlNode | null {
  const present = children.filter((c): c is XmlNode => !!c);
  return present.length ? { name, children: present } : null;
}

/** Serializa sin sangrías ni saltos de línea: la firma no depende del espacio en blanco. */
export function serialize(n: XmlNode): string {
  if ("text" in n) return `<${n.name}>${escapeXml(n.text)}</${n.name}>`;
  const inner = n.children.map((c) => (c ? serialize(c) : "")).join("");
  return `<${n.name}>${inner}</${n.name}>`;
}
