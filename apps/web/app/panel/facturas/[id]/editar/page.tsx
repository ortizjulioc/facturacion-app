import { InvoiceEditor } from "../../editor";

// Vista de cliente autenticada por cookie: no puede ser una navegación "instantánea".
export const instant = false;

export default async function Page({ params }: PageProps<"/panel/facturas/[id]/editar">) {
  const { id } = await params;
  return <InvoiceEditor docId={id} />;
}
