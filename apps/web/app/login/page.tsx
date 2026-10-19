import { safeNext } from "@/lib/next-url";
import { LoginForm } from "./login-form";

// El formulario depende de ?next=… (se conoce solo en la petición). Se renderiza sin <Suspense>
// para que hidrate de inmediato: un formulario de acceso no puede quedar "dormido".
export const instant = false;

export default async function Page({ searchParams }: PageProps<"/login">) {
  const sp = await searchParams;
  return <LoginForm next={safeNext(sp.next)} />;
}
