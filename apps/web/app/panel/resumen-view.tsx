"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { api, authClient } from "@/lib/api";

type Branch = { id: string; name: string; code: string; address: string | null };

export default function PanelPage() {
  const router = useRouter();
  const { data: session, isPending } = authClient.useSession();
  const { data: org } = authClient.useActiveOrganization();
  const [branches, setBranches] = useState<Branch[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!isPending && !session) router.replace("/login");
  }, [isPending, session, router]);

  useEffect(() => {
    if (!org?.id) return;
    let cancelled = false;
    void api.v1.branches.$get().then(async (res) => {
      if (res.ok && !cancelled) setBranches((await res.json()).branches);
    });
    return () => {
      cancelled = true;
    };
  }, [org?.id, reloadKey]);

  async function addBranch(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const formEl = e.currentTarget;
    const form = new FormData(formEl);
    const res = await api.v1.branches.$post({
      json: { name: String(form.get("name")), code: String(form.get("code")) },
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(body?.error ?? "No se pudo crear la sucursal");
      return;
    }
    formEl.reset();
    setReloadKey((k) => k + 1);
  }

  async function signOut() {
    await authClient.signOut();
    router.push("/login");
  }

  if (isPending || !session) {
    return <p className="p-8 text-sm text-zinc-500">Cargando…</p>;
  }

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 space-y-8 px-6 py-12">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{org?.name ?? "Sin empresa activa"}</h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">{session.user.email}</p>
        </div>
        <button onClick={signOut} className="text-sm underline">
          Salir
        </button>
      </header>

      <section className="space-y-4">
        <h2 className="text-lg font-medium">Sucursales</h2>
        <ul className="divide-y divide-zinc-200 rounded-md border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
          {branches.length === 0 && (
            <li className="px-4 py-3 text-sm text-zinc-500">Aún no hay sucursales.</li>
          )}
          {branches.map((b) => (
            <li key={b.id} className="flex justify-between px-4 py-3 text-sm">
              <span>{b.name}</span>
              <span className="font-mono text-zinc-500">{b.code}</span>
            </li>
          ))}
        </ul>
        <form onSubmit={addBranch} className="flex flex-wrap gap-2">
          <input
            required
            name="name"
            placeholder="Nombre"
            className="min-w-40 flex-1 rounded-md border border-zinc-300 bg-transparent px-3 py-2 text-sm dark:border-zinc-700"
          />
          <input
            required
            name="code"
            placeholder="Código"
            className="w-28 rounded-md border border-zinc-300 bg-transparent px-3 py-2 text-sm dark:border-zinc-700"
          />
          <button className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background">
            Agregar
          </button>
        </form>
        {error && <p className="text-sm text-red-600">{error}</p>}
      </section>
    </main>
  );
}
