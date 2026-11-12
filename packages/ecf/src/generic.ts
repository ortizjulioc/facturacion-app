/**
 * Armado genérico de XML a partir de campos, guiado por los XSD oficiales de la DGII.
 *
 * El armado normal (`buildEcf`) sale de las facturas del sistema y cubre lo que el sistema emite. Este, en cambio,
 * recibe los campos tal como los nombra la DGII —en un objeto anidado como el XML: `Encabezado.IdDoc.TipoeCF`,
 * `DetallesItems.Item[0].NombreItem`…— y los acomoda en el orden exacto del XSD de su tipo. Sirve para:
 *  - el set de pruebas de la certificación, que da cada comprobante campo por campo (hay que generarlo «con los
 *    mismos campos y en el mismo orden»);
 *  - tipos y áreas que el sistema todavía no arma (41, 43, 44–47, otra moneda, retenciones por línea, transporte…).
 *
 * Solo revisa la ESTRUCTURA (qué campos existen, en qué orden, cuáles faltan y cuántas veces se repiten). Los formatos
 * de cada valor (fechas, montos, catálogos) los valida el XSD: conviene validar el resultado antes de enviarlo.
 */
import { DOMParser, type Element as XmlElement } from "@xmldom/xmldom";
import { escapeXml } from "./format";
import { SCHEMAS } from "./schemas.generated";
import { EcfError } from "./types";

/** Un elemento del XSD: nombre, mínimo y máximo de apariciones (-1 = sin límite) y sus hijos si es compuesto. */
export type SchemaNode = { n: string; min: number; max: number; c?: SchemaNode[]; any?: true };

export type FieldValue = string | number | boolean | null | undefined | FieldObject | FieldValue[];
export type FieldObject = { [field: string]: FieldValue };

/** Documentos que se pueden armar: un e-CF por su tipo, el resumen de consumo, la anulación y las respuestas. */
export const GENERIC_SCHEMAS = Object.keys(SCHEMAS) as readonly string[];

/** Campos que agrega la firma, no quien arma el documento. */
const SIGNING_FIELDS = new Set(["FechaHoraFirma"]);

const isObject = (v: FieldValue): v is FieldObject => typeof v === "object" && v !== null && !Array.isArray(v);
const isEmpty = (v: FieldValue) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");

/**
 * Arma el XML (sin firmar) de un documento a partir de sus campos. `schema` es el nombre del XSD («ECF-31»,
 * «RFCE», «ACECF»…). Acepta el objeto con o sin el elemento raíz (`{ ECF: {...} }` o `{ Encabezado, DetallesItems }`).
 * Lanza `EcfError` con TODOS los problemas encontrados, uno por línea.
 */
export function buildFromFields(schema: string, fields: FieldObject): string {
  const root = SCHEMAS[schema];
  if (!root) throw new EcfError(`No hay un XSD para «${schema}»`);
  const value = isObject(fields[root.n]) && Object.keys(fields).length === 1 ? (fields[root.n] as FieldObject) : fields;
  const problems: string[] = [];
  const xml = element(root, value, root.n, problems);
  if (problems.length) throw new EcfError(problems.join("\n"));
  return xml ?? `<${root.n}></${root.n}>`;
}

/** Arma un e-CF eligiendo el XSD por su `Encabezado.IdDoc.TipoeCF` (31, 32, 33, 34, 41, 43, 44, 45, 46 o 47). */
export function buildEcfFromFields(fields: FieldObject): string {
  const ecf = isObject(fields.ECF) ? fields.ECF : fields;
  const encabezado = isObject(ecf.Encabezado) ? ecf.Encabezado : null;
  const idDoc = encabezado && isObject(encabezado.IdDoc) ? encabezado.IdDoc : null;
  const type = idDoc ? String(idDoc.TipoeCF ?? "").trim() : "";
  if (!type) throw new EcfError("Falta «ECF.Encabezado.IdDoc.TipoeCF»");
  if (!SCHEMAS[`ECF-${type}`]) throw new EcfError(`Tipo de e-CF no soportado: «${type}»`);
  return buildFromFields(`ECF-${type}`, fields);
}

/** Un elemento: devuelve su XML, o null si no lleva nada y es opcional. */
function element(node: SchemaNode, value: FieldValue, path: string, problems: string[]): string | null {
  if (!node.c) {
    if (isObject(value) || Array.isArray(value)) {
      problems.push(`«${path}» es un valor simple, no un grupo`);
      return null;
    }
    return isEmpty(value) ? null : `<${node.n}>${escapeXml(String(value).trim())}</${node.n}>`;
  }
  if (!isObject(value)) {
    if (!isEmpty(value)) problems.push(`«${path}» es un grupo de campos, no un valor`);
    return node.min > 0 ? `<${node.n}></${node.n}>` : null;
  }
  const known = new Set(node.c.map((c) => c.n));
  for (const key of Object.keys(value)) {
    if (!known.has(key) && !isEmpty(value[key])) problems.push(`Campo desconocido «${path}.${key}» (no está en el XSD)`);
  }
  let inner = "";
  for (const child of node.c) {
    if (child.any || SIGNING_FIELDS.has(child.n)) continue;
    const childPath = `${path}.${child.n}`;
    const raw = value[child.n];
    const items = (Array.isArray(raw) ? raw : [raw]).filter((v) => !isEmpty(v));
    if (child.max !== -1 && items.length > child.max) problems.push(`«${childPath}» admite hasta ${child.max} (vinieron ${items.length})`);
    let present = 0;
    items.forEach((item, i) => {
      const out = element(child, item, items.length > 1 ? `${childPath}[${i + 1}]` : childPath, problems);
      if (out) {
        inner += out;
        present++;
      }
    });
    if (present < child.min) {
      // Un grupo obligatorio sin datos se emite vacío si todo lo suyo es opcional (p. ej. Comprador en el 32).
      if (child.c && present === 0 && child.min === 1 && !hasRequired(child)) inner += `<${child.n}></${child.n}>`;
      else problems.push(`Falta «${childPath}»${child.min > 1 ? ` (al menos ${child.min})` : ""}`);
    }
  }
  return inner || node.min > 0 ? `<${node.n}>${inner}</${node.n}>` : null;
}

const hasRequired = (node: SchemaNode): boolean => (node.c ?? []).some((c) => !c.any && !SIGNING_FIELDS.has(c.n) && c.min > 0);

/**
 * Lee un XML de la DGII a campos con la misma forma que recibe `buildFromFields` (los elementos repetidos, como
 * arreglo). Útil para comparar, depurar el set de pruebas o partir de un ejemplo. Descarta la firma.
 */
export function fieldsFromXml(xml: string): FieldObject {
  const doc = new DOMParser().parseFromString(xml.trim(), "text/xml");
  const read = (el: XmlElement): FieldValue => {
    const kids = Array.from({ length: el.childNodes.length }, (_, i) => el.childNodes[i]).filter((n): n is XmlElement => n?.nodeType === 1);
    if (kids.length === 0) return el.textContent ?? "";
    const out: FieldObject = {};
    for (const k of kids) {
      if (k.nodeName === "Signature") continue;
      const v = read(k);
      const prev = out[k.nodeName];
      out[k.nodeName] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
    }
    return out;
  };
  const root = doc.documentElement as unknown as XmlElement;
  return { [root.nodeName]: read(root) };
}

/**
 * Se queda solo con los campos que existen en el XSD indicado (recorre grupos y repetidos). Sirve para sacar de un e-CF
 * documentos que son un subconjunto suyo, como el resumen de la factura de consumo.
 */
export function projectFields(schema: string, fields: FieldObject): FieldObject {
  const root = SCHEMAS[schema];
  if (!root) throw new EcfError(`No hay un XSD para «${schema}»`);
  const keep = (node: SchemaNode, value: FieldValue): FieldValue => {
    if (Array.isArray(value)) return value.map((v) => keep(node, v));
    if (!node.c || !isObject(value)) return value;
    const out: FieldObject = {};
    for (const child of node.c) if (child.n in value) out[child.n] = keep(child, value[child.n]);
    return out;
  };
  const inner = isObject(fields.ECF) ? fields.ECF : isObject(fields[root.n]) ? (fields[root.n] as FieldObject) : fields;
  return { [root.n]: keep(root, inner) as FieldObject };
}

/** Resumen (RFCE) de una factura de consumo dada por campos, con el código de seguridad de la firma del e-CF completo. */
export function buildSummaryFromFields(ecfFields: FieldObject, securityCode: string): string {
  const summary = projectFields("RFCE", ecfFields) as { RFCE: FieldObject };
  const encabezado = (isObject(summary.RFCE.Encabezado) ? summary.RFCE.Encabezado : {}) as FieldObject;
  summary.RFCE.Encabezado = { ...encabezado, CodigoSeguridadeCF: securityCode };
  return buildFromFields("RFCE", summary);
}
