import { formatEncf, type AnyEcfType } from "@facturacion/core";
import { formatDateTime, leaf, node, serialize, type XmlNode } from "./format";
import { EcfError } from "./types";

/** Un rango consecutivo de e-NCF que se anula (los dos extremos incluidos). */
export type AnnulmentRange = { from: bigint; to: bigint };

/** Todos los rangos anulados de un tipo de comprobante (una línea `Anulacion` del formato). */
export type AnnulmentLine = { type: AnyEcfType; ranges: AnnulmentRange[] };

export type AnnulmentInput = {
  /** RNC del emisor que anula. */
  rnc: string;
  lines: AnnulmentLine[];
  at: Date;
};

/** Límites del formato: hasta 10 líneas (una por tipo) y 10,000 rangos por línea. */
const MAX_LINES = 10;
const MAX_RANGES = 10_000;

/** Cuántos e-NCF cubren los rangos. */
export const countOf = (ranges: AnnulmentRange[]) => ranges.reduce((n, r) => n + Number(r.to - r.from + 1n), 0);

/**
 * Archivo de anulación de rangos de e-NCF (ANECF), sin firmar: encabezado con quién anula y cuántos e-NCF, y una línea
 * por tipo de comprobante con sus rangos «desde–hasta». Solo se anulan secuencias NO usadas. Formato oficial «Formato
 * Anulación de e-NCF v1.0»; el nombre del elemento que envuelve cada par desde/hasta (`Secuencia`) no figura en el PDF
 * y sale del XSD, que no se pudo consultar.
 */
export function buildAnecf(input: AnnulmentInput): string {
  if (input.lines.length === 0) throw new EcfError("Indica al menos un rango para anular");
  if (input.lines.length > MAX_LINES) throw new EcfError("El archivo de anulación admite hasta 10 tipos de comprobante");
  const seen = new Set<string>();

  const lines = input.lines.map((line, i) => {
    if (seen.has(line.type)) throw new EcfError(`El tipo ${line.type} aparece dos veces: agrupa sus rangos en una sola línea`);
    seen.add(line.type);
    if (line.ranges.length === 0) throw new EcfError(`El tipo ${line.type} no tiene rangos`);
    if (line.ranges.length > MAX_RANGES) throw new EcfError("Un tipo de comprobante admite hasta 10,000 rangos por archivo");
    for (const r of line.ranges) {
      if (r.from < 1n || r.to < r.from) throw new EcfError("Un rango es inválido: el inicio debe ser mayor que cero y no mayor que el final");
      if (r.to > 9_999_999_999n) throw new EcfError("Un rango pasa del último número posible");
    }
    // Los rangos de una línea no se pueden solapar (el mismo e-NCF anulado dos veces).
    const sorted = [...line.ranges].sort((a, b) => (a.from < b.from ? -1 : 1));
    for (let k = 1; k < sorted.length; k++) {
      if (sorted[k]!.from <= sorted[k - 1]!.to) throw new EcfError(`Los rangos del tipo ${line.type} se solapan`);
    }
    return node(
      "Anulacion",
      leaf("NoLinea", i + 1),
      leaf("TipoeCF", line.type.slice(1)),
      node(
        "TablaRangoSecuenciasAnuladaseNCF",
        ...sorted.map((r) =>
          node("Secuencia", leaf("SecuenciaeNCFDesde", formatEncf(line.type, r.from)), leaf("SecuenciaeNCFHasta", formatEncf(line.type, r.to))),
        ),
      ),
      leaf("CantidadeNCFAnulados", countOf(line.ranges)),
    );
  });

  const total = input.lines.reduce((n, l) => n + countOf(l.ranges), 0);
  const root: XmlNode = {
    name: "ANECF",
    children: [
      node("Encabezado", leaf("Version", "1.0"), leaf("RncEmisor", input.rnc), leaf("CantidadeNCFAnulados", total), leaf("FechaHoraAnulacioneNCF", formatDateTime(input.at))),
      node("DetalleAnulacion", ...lines),
    ],
  };
  return serialize(root);
}

