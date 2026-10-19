"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button, ErrorNote, Field, Input } from "@/components/ui";
import { authClient } from "@/lib/api";

export function LoginForm({ next }: { next?: string }) {
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

    // Si va a aceptar una invitación, la empresa activa se elige al aceptarla.
    if (!next) {
      const session = await authClient.getSession();
      if (!session.data?.session.activeOrganizationId) {
        const orgs = await authClient.organization.list();
        const first = orgs.data?.[0];
        if (first) await authClient.organization.setActive({ organizationId: first.id });
      }
    }
    router.push(next ?? "/panel");
  }

  const registerHref = next ? `/registro?next=${encodeURIComponent(next)}` : "/registro";

  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-6 py-16">
      <h1 className="text-2xl font-semibold">Iniciar sesión</h1>
      <form method="post" onSubmit={onSubmit} className="flex flex-col gap-4">
        <Field label="Correo">
          <Input required name="email" type="email" autoComplete="email" />
        </Field>
        <Field label="Contraseña">
          <Input
            required
            name="password"
            type="password"
            autoComplete="current-password"
          />
        </Field>
        <ErrorNote message={error} />
        <Button disabled={loading}>{loading ? "Entrando…" : "Entrar"}</Button>
      </form>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        ¿No tienes cuenta?{" "}
        <Link href={registerHref} className="font-medium underline">
          {next ? "Crea una cuenta" : "Crea tu empresa"}
        </Link>
      </p>
    </main>
  );
}
