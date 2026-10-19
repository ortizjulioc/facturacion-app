import { FacturasView } from "./facturas-view";

// Vista de cliente autenticada por cookie: no puede ser una navegación "instantánea".
export const instant = false;

// /panel/facturas?estado=borrador abre el listado ya filtrado (lo usa el resumen).
export default async function Page({ searchParams }: PageProps<"/panel/facturas">) {
  const sp = await searchParams;
  const estado = Array.isArray(sp.estado) ? sp.estado[0] : sp.estado;
  const initialStatus = estado === "borrador" ? "DRAFT" : "";
  // La key remonta el listado si cambia el filtro (Next conserva ocultas las pantallas anteriores).
  return <FacturasView key={initialStatus} initialStatus={initialStatus} />;
}
