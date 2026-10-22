"use client";

import { useState, type FormEvent } from "react";
import { Badge, Button, ErrorNote, Field, Input } from "@/components/ui";
import { useDialogs } from "@/components/dialogs";
import { api, errorMessage, expectOk, unwrap } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { useQuery } from "@/lib/use-query";

async function loadCertificate() {
  return (await unwrap(await api.v1.company.certificate.$get())).data;
}

/** Bytes del archivo en base64 (el .p12 pesa unos pocos KB). */
async function toBase64(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** Certificado digital (.p12) con el que se firman los e-CF. La contraseña y el archivo se guardan cifrados. */
export function CertificateCard({ canManage }: { canManage: boolean }) {
  const { confirm, toast } = useDialogs();
  const { data: cert, error, reload } = useQuery(loadCertificate);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFormError(null);
    const form = e.currentTarget;
    const f = new FormData(form);
    const file = f.get("file");
    if (!(file instanceof File) || file.size === 0) return setFormError("Elige el archivo del certificado (.p12 o .pfx)");
    if (file.size > 100_000) return setFormError("El archivo es demasiado grande para ser un certificado");
    setSaving(true);
    try {
      const info = await unwrap(
        await api.v1.company.certificate.$put({
          json: { p12: await toBase64(file), password: String(f.get("password") ?? "") },
        }),
      );
      form.reset();
      toast(`Certificado guardado: ${info.data.subject}`);
      reload();
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    const ok = await confirm({
      title: "Quitar el certificado",
      message: "Dejarán de firmarse los comprobantes nuevos hasta que subas otro certificado.",
      confirmLabel: "Quitar",
      danger: true,
    });
    if (!ok) return;
    try {
      await expectOk(await api.v1.company.certificate.$delete());
      reload();
    } catch (err) {
      setFormError(errorMessage(err));
    }
  }

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-medium">Certificado digital</h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Con él se firma cada e-CF y se obtiene el código de seguridad del QR. El archivo y la contraseña se guardan cifrados
          y no se pueden descargar.
        </p>
      </div>
      <ErrorNote message={error} />

      {cert ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-zinc-200 p-4 text-sm dark:border-zinc-800">
          <div className="space-y-1">
            <p className="font-medium">{cert.subject}</p>
            <p className="text-zinc-600 dark:text-zinc-400">
              Vigente hasta {formatDateTime(cert.notAfter)} · cargado {formatDateTime(cert.uploadedAt)}
            </p>
            {cert.problem ? <Badge tone="warning">{cert.problem}</Badge> : <Badge tone="success">Listo para firmar</Badge>}
          </div>
          {canManage && (
            <Button variant="danger" onClick={() => void remove()}>
              Quitar
            </Button>
          )}
        </div>
      ) : (
        cert === null && (
          <p className="rounded-md bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
            Aún no hay un certificado: los comprobantes se emiten sin firma y sin QR. Podrás firmarlos después.
          </p>
        )
      )}

      {canManage && (
        <form onSubmit={onSubmit} className="grid gap-4 md:grid-cols-[1fr_1fr_auto] md:items-end">
          <Field label={cert ? "Reemplazar certificado" : "Archivo del certificado"} hint=".p12 o .pfx">
            <Input name="file" type="file" accept=".p12,.pfx,application/x-pkcs12" required />
          </Field>
          <Field label="Contraseña del certificado">
            <Input name="password" type="password" autoComplete="off" required />
          </Field>
          <Button disabled={saving}>{saving ? "Guardando…" : "Guardar certificado"}</Button>
        </form>
      )}
      <ErrorNote message={formError} />
    </section>
  );
}
