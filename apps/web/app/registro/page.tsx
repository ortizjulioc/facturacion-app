"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { authClient } from "@/lib/api";

const slugify = (v: string) =>
  v
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

export default function RegistroPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const form = new FormData(e.currentTarget);
    const empresa = String(form.get("empresa"));

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

  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-6 py-16">
      <h1 className="text-2xl font-semibold">Crear empresa</h1>
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <Field label="Tu nombre" name="nombre" autoComplete="name" />
        <Field label="Nombre de la empresa" name="empresa" autoComplete="organization" />
        <Field label="Correo" name="email" type="email" autoComplete="email" />
        <Field
          label="Contraseña (mínimo 10 caracteres)"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={10}
        />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button
          disabled={loading}
          className="rounded-md bg-foreground px-4 py-2.5 text-sm font-medium text-background disabled:opacity-60"
        >
          {loading ? "Creando…" : "Crear cuenta y empresa"}
        </button>
      </form>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        ¿Ya tienes cuenta?{" "}
        <Link href="/login" className="font-medium underline">
          Inicia sesión
        </Link>
      </p>
    </main>
  );
}

function Field({ label, ...props }: { label: string } & React.ComponentProps<"input">) {
  return (
    <label className="flex flex-col gap-1.5 text-sm font-medium">
      {label}
      <input
        required
        {...props}
        className="rounded-md border border-zinc-300 bg-transparent px-3 py-2 font-normal dark:border-zinc-700"
      />
    </label>
  );
}
