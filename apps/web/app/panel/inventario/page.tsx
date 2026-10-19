import { InventarioView } from "./inventario-view";

// Vista de cliente autenticada por cookie: no puede ser una navegación "instantánea".
export const instant = false;

// /panel/inventario?stock=bajo abre las existencias ya filtradas (lo usa el resumen).
export default async function Page({ searchParams }: PageProps<"/panel/inventario">) {
  const sp = await searchParams;
  const stock = Array.isArray(sp.stock) ? sp.stock[0] : sp.stock;
  const lowOnly = stock === "bajo";
  // La key remonta la vista si cambia el filtro (Next conserva ocultas las pantallas anteriores).
  return <InventarioView key={String(lowOnly)} initialLowOnly={lowOnly} />;
}
