"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, ErrorNote } from "@/components/ui";
import { authClient } from "@/lib/api";

export function InvitationView({ id }: { id: string }) {
  const router = useRouter();
  const { data: session, isPending } = authClient.useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const next = `/invitacion/${id}`;

  async function accept() {
    setBusy(true);
    setError(null);
    const res = await authClient.organization.acceptInvitation({ invitationId: id });
    if (res.error) {
      setError(
        res.error.message ??
          "No se pudo aceptar la invitación. Verifica que uses el correo al que fue enviada.",
      );
      setBusy(false);
      return;
    }
    await authClient.organization.setActive({
      organizationId: res.data.invitation.organizationId,
    });
    router.push("/panel");
  }

  async function reject() {
    setBusy(true);
    await authClient.organization.rejectInvitation({ invitationId: id });
    router.push("/panel");
  }

  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-6 py-16">
      <h1 className="text-2xl font-semibold">Invitación a una empresa</h1>
      {isPending ? (
        <p className="text-sm text-zinc-500">Cargando…</p>
      ) : session ? (
        <>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Has sido invitado a unirte a una empresa. Estás conectado como{" "}
            <strong className="text-foreground">{session.user.email}</strong>; la
            invitación debe haberse enviado a este mismo correo.
          </p>
          <ErrorNote message={error} />
          <div className="flex gap-3">
            <Button disabled={busy} onClick={accept}>
              Aceptar invitación
            </Button>
            <Button variant="secondary" disabled={busy} onClick={reject}>
              Rechazar
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Para aceptar la invitación inicia sesión, o crea una cuenta con el correo al
            que fue enviada.
          </p>
          <div className="flex gap-3">
            <Link
              href={`/login?next=${encodeURIComponent(next)}`}
              className="rounded-md bg-foreground px-5 py-2.5 text-sm font-medium text-background"
            >
              Iniciar sesión
            </Link>
            <Link
              href={`/registro?next=${encodeURIComponent(next)}`}
              className="rounded-md border border-zinc-300 px-5 py-2.5 text-sm font-medium dark:border-zinc-700"
            >
              Crear cuenta
            </Link>
          </div>
        </>
      )}
    </main>
  );
}
