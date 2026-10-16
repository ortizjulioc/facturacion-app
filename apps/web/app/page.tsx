import Link from "next/link";
import { Suspense } from "react";

const INTERNAL_API = process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

async function ApiStatus() {
  let ok = false;
  try {
    const res = await fetch(`${INTERNAL_API}/health`, { cache: "no-store" });
    ok = res.ok;
  } catch {
    ok = false;
  }
  return (
    <p className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
      <span className={`h-2 w-2 rounded-full ${ok ? "bg-emerald-500" : "bg-red-500"}`} />
      API {ok ? "en línea" : "sin conexión"}
    </p>
  );
}

export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-8 px-6 py-24 text-center">
      <div className="space-y-3">
        <h1 className="text-4xl font-semibold tracking-tight">Facturación</h1>
        <p className="max-w-md text-zinc-600 dark:text-zinc-400">
          Facturación electrónica (e-CF) y punto de venta para cualquier tipo de negocio.
        </p>
      </div>
      <div className="flex gap-3">
        <Link
          href="/login"
          className="rounded-md bg-foreground px-5 py-2.5 text-sm font-medium text-background"
        >
          Iniciar sesión
        </Link>
        <Link
          href="/registro"
          className="rounded-md border border-zinc-300 px-5 py-2.5 text-sm font-medium dark:border-zinc-700"
        >
          Crear empresa
        </Link>
      </div>
      <Suspense fallback={<p className="text-sm text-zinc-500">Comprobando API…</p>}>
        <ApiStatus />
      </Suspense>
    </main>
  );
}
