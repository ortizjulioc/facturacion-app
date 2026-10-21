"use client";

import { useState, type FormEvent } from "react";
import {
  ALL_ECF_LABELS,
  ALL_ECF_TYPES,
  formatDocument,
  type AnyEcfType,
} from "@facturacion/core";
import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  Modal,
  PageHeader,
  Select,
  tableStyles,
} from "@/components/ui";
import { useDialogs } from "@/components/dialogs";
import { usePanel } from "@/components/panel-context";
import { api, errorMessage, unwrap } from "@/lib/api";
import { useQuery } from "@/lib/use-query";

const ENVIRONMENTS = [
  { value: "TEST", label: "Pruebas (TesteCF)" },
  { value: "CERT", label: "Certificación (CerteCF)" },
  { value: "PROD", label: "Producción (eCF)" },
];

async function loadFiscal() {
  const [company, sequences, terminals] = await Promise.all([
    unwrap(await api.v1.company.$get()),
    unwrap(await api.v1.sequences.$get()),
    unwrap(await api.v1.terminals.$get({ query: {} })),
  ]);
  return { company: company.data, sequences: sequences.data, terminals: terminals.data };
}

type Loaded = Awaited<ReturnType<typeof loadFiscal>>;
type Sequence = Loaded["sequences"][number];

export function FiscalView() {
  const { canManage } = usePanel();
  const { toast } = useDialogs();
  const { data, error, reload } = useQuery(loadFiscal);
  const [sequenceModal, setSequenceModal] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  async function toggleSequence(s: Sequence) {
    setActionError(null);
    try {
      await unwrap(
        await api.v1.sequences[":id"].$patch({
          param: { id: s.id },
          json: { active: !s.active },
        }),
      );
      reload();
    } catch (e) {
      setActionError(errorMessage(e));
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const terminalName = (id: string | null) =>
    id ? (data?.terminals.find((t) => t.id === id)?.name ?? "Caja") : "Toda la empresa";

  return (
    <>
      <PageHeader
        title="Configuración fiscal"
        description="Datos del emisor y rangos de e-NCF autorizados por la DGII."
      />
      <ErrorNote message={error ?? actionError} />

      <section className="space-y-4">
        <h2 className="text-lg font-medium">Datos de la empresa</h2>
        {data && !data.company && (
          <p className="rounded-md bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
            Aún no has registrado los datos fiscales. Sin ellos no se pueden emitir
            comprobantes.
          </p>
        )}
        {data && (
          <CompanyForm company={data.company} canManage={canManage} onSaved={reload} />
        )}
      </section>

      <section className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-medium">Secuencias de e-NCF</h2>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Cada tipo de comprobante necesita un rango vigente para poder emitirse.
            </p>
          </div>
          {canManage && (
            <Button onClick={() => setSequenceModal(true)}>Nueva secuencia</Button>
          )}
        </div>

        <div className={tableStyles.wrapper}>
          <table className={tableStyles.table}>
            <thead>
              <tr>
                <th className={tableStyles.th}>Tipo</th>
                <th className={tableStyles.th}>Rango</th>
                <th className={`${tableStyles.th} text-right`}>Disponibles</th>
                <th className={tableStyles.th}>Vence</th>
                <th className={tableStyles.th}>Aplica a</th>
                {canManage && <th className={tableStyles.th} />}
              </tr>
            </thead>
            <tbody>
              {data?.sequences.map((s) => {
                const expired = s.expiresAt < today;
                const exhausted = s.remaining <= 0;
                return (
                  <tr
                    key={s.id}
                    className={s.active && !expired && !exhausted ? "" : "opacity-60"}
                  >
                    <td className={tableStyles.td}>
                      <span className="font-medium">{s.ecfType}</span>
                      <div className="text-xs text-zinc-500">
                        {ALL_ECF_LABELS[s.ecfType as AnyEcfType]}
                      </div>
                    </td>
                    <td className={`${tableStyles.td} font-mono text-xs`}>
                      {s.fromNumber.toLocaleString("en-US")} –{" "}
                      {s.toNumber.toLocaleString("en-US")}
                    </td>
                    <td className={`${tableStyles.td} text-right tabular-nums`}>
                      {s.remaining.toLocaleString("en-US")}
                    </td>
                    <td className={tableStyles.td}>
                      {s.expiresAt}
                      {expired && (
                        <span className="ml-2">
                          <Badge tone="warning">Vencida</Badge>
                        </span>
                      )}
                    </td>
                    <td className={tableStyles.td}>
                      {terminalName(s.terminalId)}
                      {exhausted && (
                        <span className="ml-2">
                          <Badge tone="warning">Agotada</Badge>
                        </span>
                      )}
                      {!s.active && (
                        <span className="ml-2">
                          <Badge>Inactiva</Badge>
                        </span>
                      )}
                    </td>
                    {canManage && (
                      <td className={`${tableStyles.td} text-right`}>
                        <Button variant="ghost" onClick={() => toggleSequence(s)}>
                          {s.active ? "Desactivar" : "Activar"}
                        </Button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {data && data.sequences.length === 0 && (
            <EmptyState>
              Aún no hay secuencias. Registra el rango que te autorizó la DGII.
            </EmptyState>
          )}
          {!data && !error && <EmptyState>Cargando…</EmptyState>}
        </div>
      </section>

      <Modal
        open={sequenceModal}
        onClose={() => setSequenceModal(false)}
        title="Nueva secuencia"
      >
        {sequenceModal && (
          <SequenceForm
            terminals={data?.terminals.filter((t) => t.active) ?? []}
            onDone={() => {
              setSequenceModal(false);
              toast("Secuencia registrada");
              reload();
            }}
          />
        )}
      </Modal>
    </>
  );
}

function CompanyForm({
  company,
  canManage,
  onSaved,
}: {
  company: Loaded["company"];
  canManage: boolean;
  onSaved: () => void;
}) {
  const { toast } = useDialogs();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    setSaving(true);
    const f = new FormData(e.currentTarget);
    const text = (name: string) => String(f.get(name) ?? "").trim();
    try {
      await unwrap(
        await api.v1.company.$put({
          json: {
            rnc: text("rnc"),
            legalName: text("legalName"),
            tradeName: text("tradeName"),
            address: text("address"),
            province: text("province"),
            municipality: text("municipality"),
            economicActivity: text("economicActivity"),
            email: text("email") || null,
            phone: text("phone"),
            environment: text("environment") as "TEST" | "CERT" | "PROD",
            requireShift: f.get("requireShift") === "on",
          },
        }),
      );
      setSaved(true);
      toast("Datos fiscales guardados");
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="space-y-4 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
    >
      <fieldset disabled={!canManage || saving} className="space-y-4">
        <div className="grid gap-4 md:grid-cols-3">
          <Field label="RNC">
            <Input
              name="rnc"
              required
              defaultValue={company ? formatDocument("RNC", company.rnc) : ""}
            />
          </Field>
          <Field label="Razón social" className="md:col-span-2">
            <Input
              name="legalName"
              required
              maxLength={200}
              defaultValue={company?.legalName}
            />
          </Field>
          <Field label="Nombre comercial" className="md:col-span-2">
            <Input
              name="tradeName"
              maxLength={200}
              defaultValue={company?.tradeName ?? ""}
            />
          </Field>
          <Field label="Ambiente DGII">
            <Select name="environment" defaultValue={company?.environment ?? "TEST"}>
              {ENVIRONMENTS.map((env) => (
                <option key={env.value} value={env.value}>
                  {env.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Dirección fiscal">
          <Input
            name="address"
            required
            maxLength={250}
            defaultValue={company?.address}
          />
        </Field>
        <div className="grid gap-4 md:grid-cols-3">
          <Field label="Provincia">
            <Input
              name="province"
              maxLength={100}
              defaultValue={company?.province ?? ""}
            />
          </Field>
          <Field label="Municipio">
            <Input
              name="municipality"
              maxLength={100}
              defaultValue={company?.municipality ?? ""}
            />
          </Field>
          <Field label="Actividad económica">
            <Input
              name="economicActivity"
              maxLength={200}
              defaultValue={company?.economicActivity ?? ""}
            />
          </Field>
          <Field label="Correo">
            <Input name="email" type="email" defaultValue={company?.email ?? ""} />
          </Field>
          <Field label="Teléfono">
            <Input name="phone" type="tel" defaultValue={company?.phone ?? ""} />
          </Field>
        </div>
        <Checkbox
          name="requireShift"
          label="Exigir un turno abierto para vender desde una caja"
          defaultChecked={company?.requireShift ?? false}
        />
        <p className="-mt-2 text-xs text-zinc-500">
          La caja registradora y la facturación con caja no emiten comprobantes si no hay un turno abierto (se abre con el fondo y se cierra con el cuadre).
        </p>
      </fieldset>
      <ErrorNote message={error} />
      {canManage ? (
        <div className="flex items-center justify-end gap-3">
          {saved && <span className="text-sm text-emerald-600">Guardado</span>}
          <Button disabled={saving}>{saving ? "Guardando…" : "Guardar datos"}</Button>
        </div>
      ) : (
        <p className="text-sm text-zinc-500">
          Solo propietarios y administradores pueden editar estos datos.
        </p>
      )}
    </form>
  );
}

function SequenceForm({
  terminals,
  onDone,
}: {
  terminals: Loaded["terminals"];
  onDone: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    const f = new FormData(e.currentTarget);
    const terminalId = String(f.get("terminalId") ?? "");
    try {
      await unwrap(
        await api.v1.sequences.$post({
          json: {
            ecfType: String(f.get("ecfType")) as AnyEcfType,
            fromNumber: Number(f.get("fromNumber")),
            toNumber: Number(f.get("toNumber")),
            expiresAt: String(f.get("expiresAt")),
            terminalId: terminalId || null,
          },
        }),
      );
      onDone();
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <Field label="Tipo de comprobante">
        <Select name="ecfType" defaultValue="E32">
          {ALL_ECF_TYPES.map((t) => (
            <option key={t} value={t}>
              {t} · {ALL_ECF_LABELS[t]}
            </option>
          ))}
        </Select>
      </Field>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Desde">
          <Input
            name="fromNumber"
            type="number"
            min={1}
            max={9999999999}
            required
            defaultValue={1}
          />
        </Field>
        <Field label="Hasta">
          <Input name="toNumber" type="number" min={1} max={9999999999} required />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Vence" hint="Fecha de vencimiento que te dio la DGII">
          <Input name="expiresAt" type="date" required />
        </Field>
        <Field label="Aplica a">
          <Select name="terminalId" defaultValue="">
            <option value="">Toda la empresa</option>
            {terminals.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <ErrorNote message={error} />
      <div className="flex justify-end">
        <Button disabled={saving}>{saving ? "Guardando…" : "Registrar secuencia"}</Button>
      </div>
    </form>
  );
}
