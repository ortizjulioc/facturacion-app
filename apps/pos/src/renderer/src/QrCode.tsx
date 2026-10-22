import QRCode from "qrcode";
import { useEffect, useState } from "react";

/** Código QR en SVG, generado en la propia pantalla (sin internet ni servicios externos). */
export function QrCode({ text, size = 120, label }: { text: string; size?: number; label: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    QRCode.toString(text, { type: "svg", margin: 0, errorCorrectionLevel: "M" }).then(
      (s) => alive && setSvg(s),
      () => alive && setSvg(null),
    );
    return () => {
      alive = false;
    };
  }, [text]);
  if (!svg) return null;
  // El SVG lo genera esta misma librería a partir de un texto: no contiene nada que venga de terceros.
  return <div role="img" aria-label={label} style={{ width: size, height: size }} dangerouslySetInnerHTML={{ __html: svg }} />;
}
