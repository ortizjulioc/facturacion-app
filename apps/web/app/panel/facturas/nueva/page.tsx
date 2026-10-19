import { InvoiceEditor } from "../editor";
import { ECF_TYPES, type EcfType } from "@facturacion/core";

// Vista de cliente autenticada por cookie: no puede ser una navegación "instantánea".
export const instant = false;

// /panel/facturas/nueva?type=E34&ref=<id del comprobante a modificar>
export default async function Page({ searchParams }: PageProps<"/panel/facturas/nueva">) {
  const sp = await searchParams;
  const type = Array.isArray(sp.type) ? sp.type[0] : sp.type;
  const ref = Array.isArray(sp.ref) ? sp.ref[0] : sp.ref;
  const initialType = (ECF_TYPES as readonly string[]).includes(type ?? "") ? (type as EcfType) : undefined;
  return <InvoiceEditor initialType={initialType} referencedId={ref} />;
}
