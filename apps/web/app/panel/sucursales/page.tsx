import { SucursalesView } from "./sucursales-view";

// Vista de cliente autenticada por cookie: no puede ser una navegación "instantánea".
export const instant = false;

export default function Page() {
  return <SucursalesView />;
}
