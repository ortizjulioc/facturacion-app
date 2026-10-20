import { PurchaseEditor } from "../../editor";

// Vista de cliente autenticada por cookie: no puede ser una navegación "instantánea".
export const instant = false;

export default async function Page({ params }: PageProps<"/panel/compras/[id]/editar">) {
  const { id } = await params;
  return <PurchaseEditor purchaseId={id} />;
}
