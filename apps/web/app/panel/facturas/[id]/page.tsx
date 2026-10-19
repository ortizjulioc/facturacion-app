import { InvoiceDetail } from "./detail";

// Vista de cliente autenticada por cookie: no puede ser una navegación "instantánea".
export const instant = false;

export default async function Page({ params }: PageProps<"/panel/facturas/[id]">) {
  const { id } = await params;
  return <InvoiceDetail id={id} />;
}
