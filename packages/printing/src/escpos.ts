import { CODE_PAGE_ID, encodeText, type CodePage } from "./encoding";

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

export type Align = "left" | "center" | "right";

export type EscPosOptions = {
  /** Columnas por línea: 48 en papel de 80 mm, 32 en papel de 58 mm (fuente A). */
  cols: number;
  codePage?: CodePage;
};

/**
 * Constructor de comandos ESC/POS (el lenguaje de casi todas las impresoras térmicas de tickets). Cada método agrega
 * bytes y devuelve el mismo objeto, así que se encadena: `new EscPos({ cols: 48 }).init().center().line("Hola").cut().bytes()`.
 * Sin dependencias: sirve igual en la caja, en pruebas o en una vista previa.
 */
export class EscPos {
  private readonly buf: number[] = [];
  readonly cols: number;
  private readonly page: CodePage;

  constructor(opts: EscPosOptions) {
    this.cols = opts.cols;
    this.page = opts.codePage ?? "cp858";
  }

  raw(...bytes: number[]) {
    this.buf.push(...bytes);
    return this;
  }

  /** Reinicia la impresora y fija la página de códigos (para tildes y ñ). */
  init() {
    return this.raw(ESC, 0x40, ESC, 0x74, CODE_PAGE_ID[this.page]);
  }

  align(a: Align) {
    return this.raw(ESC, 0x61, { left: 0, center: 1, right: 2 }[a]);
  }
  center() {
    return this.align("center");
  }
  left() {
    return this.align("left");
  }

  bold(on = true) {
    return this.raw(ESC, 0x45, on ? 1 : 0);
  }

  /** Tamaño del carácter: 1 = normal, 2 = doble ancho y alto (títulos y total). */
  size(n: 1 | 2 | 3) {
    const k = n - 1;
    return this.raw(GS, 0x21, (k << 4) | k);
  }

  text(s: string) {
    this.buf.push(...encodeText(s, this.page));
    return this;
  }

  line(s = "") {
    return this.text(s).raw(LF);
  }

  feed(n = 1) {
    return this.raw(ESC, 0x64, Math.min(255, Math.max(0, n)));
  }

  /** Línea de guiones del ancho del papel. */
  rule(ch = "-") {
    return this.line(ch.repeat(this.cols));
  }

  /** Izquierda y derecha en la misma línea; si no caben juntas, la izquierda se parte en varias líneas. */
  columns(left: string, right: string) {
    const space = this.cols - right.length - 1;
    if (space < 4) return this.line(left).line(right.padStart(this.cols));
    const rows = wrap(left, space);
    rows.forEach((row, i) => {
      if (i === rows.length - 1) this.line(row.padEnd(this.cols - right.length) + right);
      else this.line(row);
    });
    return this;
  }

  /** Texto largo partido por palabras al ancho del papel. */
  paragraph(s: string, align: Align = "left") {
    this.align(align);
    for (const row of wrap(s, this.cols)) this.line(row);
    return this.align("left");
  }

  /**
   * Código QR (comandos nativos GS ( k, modelo 2). `moduleSize` 1–16 puntos por módulo; con 6 se lee bien en 80 mm.
   * La corrección de errores `M` tolera ~15 % de daño.
   */
  qr(data: string, moduleSize = 6, level: "L" | "M" | "Q" | "H" = "M") {
    const payload = new TextEncoder().encode(data);
    if (payload.length === 0 || payload.length > 7000) throw new Error("El texto del QR debe tener entre 1 y 7000 bytes");
    const store = payload.length + 3;
    this.raw(GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00); // modelo 2
    this.raw(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, Math.min(16, Math.max(1, moduleSize)));
    this.raw(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, { L: 0x30, M: 0x31, Q: 0x32, H: 0x33 }[level]);
    this.raw(GS, 0x28, 0x6b, store & 0xff, (store >> 8) & 0xff, 0x31, 0x50, 0x30, ...payload);
    return this.raw(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30); // imprimir lo guardado
  }

  /** Abre la gaveta de dinero conectada a la impresora (pin 2, pulso de ~50 ms). */
  openDrawer() {
    return this.raw(ESC, 0x70, 0x00, 0x19, 0xfa);
  }

  /** Avanza el papel y hace el corte parcial. */
  cut() {
    return this.raw(GS, 0x56, 0x42, 0x00);
  }

  bytes(): Uint8Array {
    return Uint8Array.from(this.buf);
  }
}

/** Parte un texto en líneas de hasta `width` caracteres, cortando por palabras (y por la fuerza las muy largas). */
export function wrap(s: string, width: number): string[] {
  const rows: string[] = [];
  for (const paragraph of s.split("\n")) {
    let current = "";
    for (let word of paragraph.split(/\s+/).filter(Boolean)) {
      while (word.length > width) {
        if (current) {
          rows.push(current);
          current = "";
        }
        rows.push(word.slice(0, width));
        word = word.slice(width);
      }
      if (!current) current = word;
      else if (current.length + 1 + word.length <= width) current += ` ${word}`;
      else {
        rows.push(current);
        current = word;
      }
    }
    rows.push(current);
  }
  return rows.length === 0 ? [""] : rows;
}
