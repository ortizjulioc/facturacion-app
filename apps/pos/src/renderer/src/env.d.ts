/// <reference types="vite/client" />
import type { PosBridge } from "../../shared/api";

declare global {
  interface Window {
    /** Puente hacia el programa (lo inyecta el preload). */
    pos: PosBridge;
  }
}
