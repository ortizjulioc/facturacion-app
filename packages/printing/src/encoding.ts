/**
 * Codificación de texto para impresoras térmicas: casi todas imprimen con una página de códigos de 8 bits, no con
 * Unicode. Usamos CP858 (CP850 con el euro), que trae todas las letras del español, y CP437 como alternativa para
 * impresoras viejas. La mitad alta (0x80–0xFF) de cada página se define aquí; la baja es ASCII.
 */

export type CodePage = "cp858" | "cp850" | "cp437";

/** Número de página que se manda con `ESC t n` (juego de comandos Epson). */
export const CODE_PAGE_ID: Record<CodePage, number> = { cp437: 0, cp850: 2, cp858: 19 };

const HIGH_437 =
  "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";
const HIGH_850 =
  "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµþÞÚÛÙýÝ¯´­±‗¾¶§÷¸°¨·¹³²■ ";
// CP858 = CP850 con «€» en lugar de «ı» (0xD5).
const HIGH_858 = HIGH_850.replace("ı", "€");

const HIGH: Record<CodePage, string> = { cp437: HIGH_437, cp850: HIGH_850, cp858: HIGH_858 };

const reverse = new Map<CodePage, Map<string, number>>();
function table(page: CodePage) {
  let t = reverse.get(page);
  if (!t) {
    t = new Map([...HIGH[page]].map((ch, i) => [ch, 0x80 + i] as const));
    reverse.set(page, t);
  }
  return t;
}

const stripAccents = (ch: string) => ch.normalize("NFD").replace(/[̀-ͯ]/g, "");

/** Texto → bytes de la página de códigos. Lo que no existe en la página se aproxima sin acento o sale como «?». */
export function encodeText(text: string, page: CodePage = "cp858"): number[] {
  const t = table(page);
  const out: number[] = [];
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code >= 0x20 && code < 0x7f) out.push(code);
    else if (ch === "\n") out.push(0x0a);
    else if (ch === "\t") out.push(0x20);
    else if (t.has(ch)) out.push(t.get(ch)!);
    else {
      const plain = stripAccents(ch);
      if (plain !== ch && /^[\x20-\x7e]+$/.test(plain)) out.push(...[...plain].map((c) => c.charCodeAt(0)));
      else if (ch === "−" || ch === "–" || ch === "—") out.push(0x2d);
      else if (ch === "×") out.push(t.get("×") ?? 0x78);
      else if (ch === "’" || ch === "‘") out.push(0x27);
      else if (ch === "“" || ch === "”") out.push(0x22);
      else if (code < 0x20) continue;
      else out.push(0x3f);
    }
  }
  return out;
}

/** Bytes → texto (para pruebas y para mostrar una vista previa del ticket). */
export function decodeText(bytes: ArrayLike<number>, page: CodePage = "cp858"): string {
  const high = HIGH[page];
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    out += b >= 0x80 ? (high[b - 0x80] ?? "?") : String.fromCharCode(b);
  }
  return out;
}
