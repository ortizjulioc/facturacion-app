"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button, ErrorNote, Field, Input } from "@/components/ui";
import { authClient } from "@/lib/api";

const slugify = (v: string) =>
  v
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/**
 * Sin `next`: crea la cuenta y la empresa del usuario.
 * Con `next` (viene de una invitación): solo crea la cuenta; la empresa es a la que lo invitaron.
 */
export function RegistroForm({ next }: { next?: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const invited = Boolean(next);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const form = new FormData(e.currentTarget);

    const signUp = await authClient.signUp.email({
      name: String(form.get("nombre")),
      email: String(form.get("email")),
      password: String(form.get("password")),
    });
    if (signUp.error) {
      setError(signUp.error.message ?? "No se pudo crear la cuenta");
      setLoading(false);
      return;
    }

    if (next) {
      router.push(next);
      return;
    }

    const empresa = String(form.get("empresa"));
    const org = await authClient.organization.create({
      name: empresa,
      slug: `${slugify(empresa)}-${Math.random().toString(36).slice(2, 6)}`,
    });
    if (org.error) {
      setError(org.error.message ?? "No se pudo crear la empresa");
      setLoading(false);
      return;
    }
    await authClient.organization.setActive({ organizationId: org.data.id });
    router.push("/panel");
  }

  const loginHref = next ? `/login?next=${encodeURIComponent(next)}` : "/login";

  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-6 py-16">
      <h1 className="text-2xl font-semibold">
        {invited ? "Crear cuenta" : "Crear empresa"}
      </h1>
      {invited && (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Usa el mismo correo al que te llegó la invitación.
        </p>
      )}
      <form method="post" onSubmit={onSubmit} className="flex flex-col gap-4">
        <Field label="Tu nombre">
          <Input required name="nombre" autoComplete="name" />
        </Field>
        {!invited && (
          <Field label="Nombre de la empresa">
            <Input required name="empresa" autoComplete="organization" />
          </Field>
        )}
        <Field label="Correo">
          <Input required name="email" type="email" autoComplete="email" />
        </Field>
        <Field label="Contraseña (mínimo 10 caracteres)">
          <Input
            required
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={10}
          />
        </Field>
        <ErrorNote message={error} />
        <Button disabled={loading}>
          {loading ? "Creando…" : invited ? "Crear cuenta" : "Crear cuenta y empresa"}
        </Button>
      </form>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        ¿Ya tienes cuenta?{" "}
        <Link href={loginHref} className="font-medium underline">
          Inicia sesión
        </Link>
      </p>
    </main>
  );
}
