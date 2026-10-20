"use client";

import { useEffect, useRef } from "react";

/** Ejecuta `callback` cada `ms` mientras la pestaña está visible (para pantallas que se refrescan solas). */
export function useInterval(callback: () => void, ms: number) {
  const saved = useRef(callback);
  useEffect(() => {
    saved.current = callback;
  });
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") saved.current();
    }, ms);
    return () => clearInterval(id);
  }, [ms]);
}
