import { safeNext } from "@/lib/next-url";
import { RegistroForm } from "./registro-form";

// Ver el comentario de /login: sin <Suspense> para que el formulario hidrate de inmediato.
export const instant = false;

export default async function Page({ searchParams }: PageProps<"/registro">) {
  const sp = await searchParams;
  return <RegistroForm next={safeNext(sp.next)} />;
}
