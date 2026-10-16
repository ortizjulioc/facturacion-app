"use client";

import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "./api";

type State<T> = { data: T | undefined; error: string | null; loading: boolean };

/**
 * Carga datos al montar y cada vez que cambia `fetcher` (memoízalo con useCallback).
 * Al recargar conserva los datos anteriores en pantalla en vez de parpadear.
 * `reload()` vuelve a pedir los datos tras una mutación.
 */
export function useQuery<T>(fetcher: () => Promise<T>) {
  const [state, setState] = useState<State<T>>({ data: undefined, error: null, loading: true });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetcher().then(
      (data) => {
        if (!cancelled) setState({ data, error: null, loading: false });
      },
      (e: unknown) => {
        if (!cancelled) setState((s) => ({ ...s, error: errorMessage(e), loading: false }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [fetcher, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}

/** Valor que se actualiza `delay` ms después del último cambio (para búsquedas al escribir). */
export function useDebounced<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
}
