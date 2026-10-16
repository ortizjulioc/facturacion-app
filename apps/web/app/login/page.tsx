"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { authClient } from "@/lib/api";

export default function LoginPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const form = new FormData(e.currentTarget);

    const res = await authClient.signIn.email({
      email: String(form.get("email")),
      password: String(form.get("password")),
    });
    if (res.error) {
      setError(res.error.message ?? "Credenciales inválidas");
      setLoading(false);
      return;
    }

    // Si el usuario aún no tiene empresa activa, activa la primera.
    const session = await authClient.getSession();
    if (!session.data?.session.activeOrganizationId) {
      const orgs = await authClient.organization.list();
      const first = orgs.data?.[0];
      if (first) await authClient.organization.setActive({ organizationId: first.id });
    }
    router.push("/panel");
  }

  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-6 py-16">
      <h1 className="text-2xl font-semibold">Iniciar sesión</h1>
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Correo
          <input
            required
            name="email"
            type="email"
            autoComplete="email"
            className="rounded-md border border-zinc-300 bg-transparent px-3 py-2 font-normal dark:border-zinc-700"
          />
        </label>
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Contraseña
          <input
            required
            name="password"
            type="password"
            autoComplete="current-password"
            className="rounded-md border border-zinc-300 bg-transparent px-3 py-2 font-normal dark:border-zinc-700"
          />
        </label>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button
          disabled={loading}
          className="rounded-md bg-foreground px-4 py-2.5 text-sm font-medium text-background disabled:opacity-60"
        >
          {loading ? "Entrando…" : "Entrar"}
        </button>
      </form>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        ¿No tienes cuenta?{" "}
        <Link href="/registro" className="font-medium underline">
          Crea tu empresa
        </Link>
      </p>
    </main>
  );
}
