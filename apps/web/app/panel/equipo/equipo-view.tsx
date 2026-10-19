"use client";

import { useState, type FormEvent } from "react";
import { useDialogs } from "@/components/dialogs";
import {
  Badge,
  Button,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  Modal,
  PageHeader,
  Select,
  tableStyles,
} from "@/components/ui";
import { usePanel } from "@/components/panel-context";
import { authClient, errorMessage } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { useQuery } from "@/lib/use-query";

const ROLE_LABELS: Record<string, string> = {
  owner: "Propietario",
  admin: "Administrador",
  member: "Cajero",
};
const ROLE_HELP: Record<string, string> = {
  admin: "Administra catálogo, clientes, sucursales, datos fiscales y equipo.",
  member: "Crea y emite comprobantes y registra clientes; no cambia la configuración.",
};

async function loadTeam() {
  const res = await authClient.organization.getFullOrganization();
  if (res.error) throw new Error(res.error.message ?? "No se pudo cargar el equipo");
  return res.data;
}

type Team = NonNullable<Awaited<ReturnType<typeof loadTeam>>>;
type Member = Team["members"][number];

const roleLabel = (role: string) =>
  role
    .split(",")
    .map((r) => ROLE_LABELS[r.trim()] ?? r)
    .join(", ");

export function EquipoView() {
  const { canManage } = usePanel();
  const { data: session } = authClient.useSession();
  const { confirm, prompt, toast } = useDialogs();
  const team = useQuery(loadTeam);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  async function run(action: () => Promise<{ error?: { message?: string } | null }>) {
    setError(null);
    try {
      const res = await action();
      if (res.error)
        throw new Error(res.error.message ?? "No se pudo completar la acción");
      team.reload();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function copyLink(id: string) {
    const link = `${window.location.origin}/invitacion/${id}`;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(id);
      toast("Enlace de invitación copiado");
      setTimeout(() => setCopied((c) => (c === id ? null : c)), 2000);
    } catch {
      // Sin permiso de portapapeles: se muestra el enlace para copiarlo a mano.
      await prompt({
        title: "Enlace de invitación",
        label: "Copia este enlace y envíaselo a la persona invitada",
        initialValue: link,
        confirmLabel: "Listo",
      });
    }
  }

  const data = team.data;
  const pending = data?.invitations.filter((i) => i.status === "pending") ?? [];

  return (
    <>
      <PageHeader
        title="Equipo"
        description="Personas con acceso a esta empresa y sus permisos."
        actions={
          canManage && (
            <Button onClick={() => setInviteOpen(true)}>Invitar persona</Button>
          )
        }
      />
      <ErrorNote message={team.error ?? error} />

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Miembros</h2>
        <div className={tableStyles.wrapper}>
          <table className={tableStyles.table}>
            <thead>
              <tr>
                <th className={tableStyles.th}>Persona</th>
                <th className={tableStyles.th}>Rol</th>
                {canManage && <th className={tableStyles.th} />}
              </tr>
            </thead>
            <tbody>
              {data?.members.map((m: Member) => {
                const isMe = m.userId === session?.user.id;
                const isOwner = m.role.split(",").includes("owner");
                return (
                  <tr key={m.id}>
                    <td className={tableStyles.td}>
                      <span className="font-medium">{m.user.name}</span>
                      {isMe && (
                        <span className="ml-2">
                          <Badge>Tú</Badge>
                        </span>
                      )}
                      <div className="text-xs text-zinc-500">{m.user.email}</div>
                    </td>
                    <td className={tableStyles.td}>
                      {canManage && !isOwner && !isMe ? (
                        <Select
                          aria-label={`Rol de ${m.user.name}`}
                          className="w-44"
                          value={m.role}
                          onChange={(e) =>
                            run(() =>
                              authClient.organization.updateMemberRole({
                                memberId: m.id,
                                role: e.target.value as "admin" | "member",
                              }),
                            )
                          }
                        >
                          <option value="admin">{ROLE_LABELS.admin}</option>
                          <option value="member">{ROLE_LABELS.member}</option>
                        </Select>
                      ) : (
                        <Badge tone={isOwner ? "success" : "neutral"}>
                          {roleLabel(m.role)}
                        </Badge>
                      )}
                    </td>
                    {canManage && (
                      <td className={`${tableStyles.td} text-right`}>
                        {!isOwner && !isMe && (
                          <Button
                            variant="ghost"
                            onClick={async () => {
                              const ok = await confirm({
                                title: `Quitar a ${m.user.name}`,
                                message: "Perderá el acceso a la empresa de inmediato.",
                                confirmLabel: "Quitar",
                                danger: true,
                              });
                              if (ok) {
                                await run(() =>
                                  authClient.organization.removeMember({
                                    memberIdOrEmail: m.id,
                                  }),
                                );
                                toast("Persona removida del equipo");
                              }
                            }}
                          >
                            Quitar
                          </Button>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!data && !team.error && <EmptyState>Cargando…</EmptyState>}
        </div>
      </section>

      {canManage && (
        <section className="space-y-3">
          <h2 className="text-lg font-medium">Invitaciones pendientes</h2>
          <div className={tableStyles.wrapper}>
            <table className={tableStyles.table}>
              <thead>
                <tr>
                  <th className={tableStyles.th}>Correo</th>
                  <th className={tableStyles.th}>Rol</th>
                  <th className={tableStyles.th}>Vence</th>
                  <th className={tableStyles.th} />
                </tr>
              </thead>
              <tbody>
                {pending.map((i) => (
                  <tr key={i.id}>
                    <td className={tableStyles.td}>{i.email}</td>
                    <td className={tableStyles.td}>{roleLabel(i.role ?? "member")}</td>
                    <td className={tableStyles.td}>{formatDate(i.expiresAt)}</td>
                    <td className={`${tableStyles.td} whitespace-nowrap text-right`}>
                      <Button variant="ghost" onClick={() => copyLink(i.id)}>
                        {copied === i.id ? "¡Copiado!" : "Copiar enlace"}
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() =>
                          run(() =>
                            authClient.organization.cancelInvitation({
                              invitationId: i.id,
                            }),
                          )
                        }
                      >
                        Cancelar
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data && pending.length === 0 && (
              <EmptyState>No hay invitaciones pendientes.</EmptyState>
            )}
          </div>
        </section>
      )}

      <Modal
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        title="Invitar persona"
      >
        {inviteOpen && (
          <InviteForm
            onDone={(id) => {
              setInviteOpen(false);
              team.reload();
              void copyLink(id);
            }}
          />
        )}
      </Modal>
    </>
  );
}

function InviteForm({ onDone }: { onDone: (invitationId: string) => void }) {
  const [role, setRole] = useState<"admin" | "member">("member");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    const email = String(new FormData(e.currentTarget).get("email") ?? "").trim();
    const res = await authClient.organization.inviteMember({ email, role });
    if (res.error) {
      setError(res.error.message ?? "No se pudo crear la invitación");
      setSaving(false);
      return;
    }
    onDone(res.data.id);
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <Field label="Correo de la persona">
        <Input name="email" type="email" required autoFocus />
      </Field>
      <Field label="Rol" hint={ROLE_HELP[role]}>
        <Select
          value={role}
          onChange={(e) => setRole(e.target.value as "admin" | "member")}
        >
          <option value="member">{ROLE_LABELS.member}</option>
          <option value="admin">{ROLE_LABELS.admin}</option>
        </Select>
      </Field>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Se copiará un enlace de invitación para que se lo envíes (por ahora no se envían
        correos automáticos).
      </p>
      <ErrorNote message={error} />
      <div className="flex justify-end">
        <Button disabled={saving}>{saving ? "Invitando…" : "Crear invitación"}</Button>
      </div>
    </form>
  );
}
