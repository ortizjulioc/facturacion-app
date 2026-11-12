import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateXML } from "xmllint-wasm";

/** XSD oficiales de la DGII (copiados sin cambios en `packages/ecf/xsd`). */
export type XsdName =
  | "ECF-31" | "ECF-32" | "ECF-33" | "ECF-34" | "ECF-41" | "ECF-43" | "ECF-44" | "ECF-45" | "ECF-46" | "ECF-47"
  | "RFCE" | "ANECF" | "ARECF" | "ACECF" | "Semilla";

/**
 * Los XSD oficiales se escribieron para el validador de .NET (el de la DGII), que tolera dos cosas que el estándar XSD
 * —y libxml2— no: nombres con espacios sobrantes (`name=" IndicadorServicioTodoIncluidoType"` en el 31) y grupos
 * `(?:…)` en los patrones (fechas de ACECF, RFCE…). Se corrigen al cargar, sin cambiar lo que validan; los archivos
 * quedan tal como los publica la DGII.
 */
export function normalizeXsd(text: string): string {
  return text
    .replace(/^﻿/, "")
    .replace(/\b(name|type)="\s*([^"]*?)\s*"/g, '$1="$2"')
    .replace(/\(\?:/g, "(");
}

const cache = new Map<XsdName, string>();
const schemaOf = (name: XsdName) => {
  let text = cache.get(name);
  if (!text) {
    text = normalizeXsd(readFileSync(fileURLToPath(new URL(`../xsd/${name}.xsd`, import.meta.url)), "utf8"));
    cache.set(name, text);
  }
  return text;
};

/** Valida un XML contra un XSD oficial con libxml2 (el mismo motor de xmllint). Devuelve los errores; vacío = válido. */
export async function xsdErrors(xml: string, name: XsdName): Promise<string[]> {
  const result = await validateXML({
    xml: [{ fileName: "documento.xml", contents: xml }],
    schema: [{ fileName: `${name}.xsd`, contents: schemaOf(name) }],
  });
  return result.valid ? [] : result.errors.map((e) => e.message);
}
