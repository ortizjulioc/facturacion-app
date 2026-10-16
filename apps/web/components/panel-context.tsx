"use client";

import { createContext, useContext } from "react";

export type PanelContextValue = {
  organizationName: string;
  /** owner/admin: pueden crear y editar catálogo, sucursales y cajas. */
  canManage: boolean;
};

export const PanelContext = createContext<PanelContextValue | null>(null);

export function usePanel(): PanelContextValue {
  const value = useContext(PanelContext);
  if (!value) throw new Error("usePanel debe usarse dentro del panel");
  return value;
}
