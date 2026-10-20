import { PurchaseDetail } from "./detail";

// Vista de cliente autenticada por cookie: no puede ser una navegación "instantánea".
export const instant = false;

export default async function Page({ params }: PageProps<"/panel/compras/[id]">) {
  const { id } = await params;
  return <PurchaseDetail id={id} />;
}
