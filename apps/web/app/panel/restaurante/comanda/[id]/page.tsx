import { ComandaView } from "./comanda-view";

// Vista de cliente autenticada por cookie: no puede ser una navegación "instantánea".
export const instant = false;

export default async function Page({ params }: PageProps<"/panel/restaurante/comanda/[id]">) {
  const { id } = await params;
  return <ComandaView id={id} />;
}
