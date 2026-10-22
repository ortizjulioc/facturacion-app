"use client";

import QRCode from "qrcode";
import { useEffect, useState } from "react";

/** Código QR en SVG, generado en el navegador (sin servicios externos). */
export function QrCode({ text, size = 128, label }: { text: string; size?: number; label: string }) {
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
  // El SVG lo genera esta librería a partir del texto: no contiene nada que venga de terceros.
  return (
    <div
      role="img"
      aria-label={label}
      style={{ width: size, height: size }}
      className="[&>svg]:h-full [&>svg]:w-full"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
