/**
 * Convierte los XSD oficiales de la DGII (`packages/ecf/xsd`) en un árbol compacto de elementos —nombre, orden,
 * mínimo y máximo de apariciones— que usa el armado genérico de XML (`generic.ts`). Así el programa no lee 1.2 MB de
 * XSD en cada arranque ni depende de rutas de archivos en producción.
 *
 *   pnpm --filter @facturacion/ecf gen:schemas
 *
 * Solo hace falta volver a correrlo si la DGII publica XSD nuevos (se copian a `xsd/` tal cual).
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DOMParser, type Element } from "@xmldom/xmldom";

const here = dirname(fileURLToPath(import.meta.url));
const XSD_DIR = join(here, "..", "xsd");
const OUT = join(here, "..", "src", "schemas.generated.ts");
const XS = "http://www.w3.org/2001/XMLSchema";

type Node = { n: string; min: number; max: number; c?: Node[]; any?: true };

const children = (el: Element, local: string) =>
  Array.from({ length: el.childNodes.length }, (_, i) => el.childNodes[i]).filter(
    (n): n is Element => n?.nodeType === 1 && (n as Element).namespaceURI === XS && (n as Element).localName === local,
  );

const occurs = (el: Element, attr: string, fallback: number) => {
  const v = el.getAttribute(attr)?.trim();
  if (!v) return fallback;
  return v === "unbounded" ? -1 : Number(v);
};

function element(el: Element): Node {
  const node: Node = { n: el.getAttribute("name")!.trim(), min: occurs(el, "minOccurs", 1), max: occurs(el, "maxOccurs", 1) };
  const complex = children(el, "complexType")[0];
  const sequence = complex && children(complex, "sequence")[0];
  if (sequence) node.c = sequenceOf(sequence);
  return node;
}

function sequenceOf(seq: Element): Node[] {
  const out: Node[] = [];
  for (let i = 0; i < seq.childNodes.length; i++) {
    const n = seq.childNodes[i] as Element;
    if (n?.nodeType !== 1 || n.namespaceURI !== XS) continue;
    if (n.localName === "element") out.push(element(n));
    // <xs:any>: la firma (Signature), que agrega la firma digital, no el armado.
    else if (n.localName === "any") out.push({ n: "*", min: occurs(n, "minOccurs", 1), max: occurs(n, "maxOccurs", 1), any: true });
    else throw new Error(`Construcción no soportada en una secuencia: ${n.localName}`);
  }
  return out;
}

const schemas: Record<string, Node> = {};
for (const file of readdirSync(XSD_DIR).filter((f) => f.endsWith(".xsd")).sort()) {
  const text = readFileSync(join(XSD_DIR, file), "utf8").replace(/^﻿/, "");
  const doc = new DOMParser().parseFromString(text, "text/xml");
  const root = children(doc.documentElement as unknown as Element, "element")[0];
  if (!root) throw new Error(`${file}: sin elemento raíz`);
  schemas[file.replace(/\.xsd$/, "")] = element(root);
}

writeFileSync(
  OUT,
  `// Generado por scripts/gen-schemas.ts a partir de los XSD oficiales de la DGII (xsd/). No editar a mano.\n` +
    `/* eslint-disable */\n` +
    `import type { SchemaNode } from "./generic";\n\n` +
    `export const SCHEMAS: Record<string, SchemaNode> = ${JSON.stringify(schemas)};\n`,
);
console.log(`${Object.keys(schemas).length} esquemas → ${OUT}`);
