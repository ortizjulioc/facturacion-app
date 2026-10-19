import { ReportesView } from "./reportes-view";

// Vista de cliente autenticada por cookie: no puede ser una navegación "instantánea".
export const instant = false;

export default function Page() {
  return <ReportesView />;
}
