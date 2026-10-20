"use client";

import { useCallback, useState, type FormEvent } from "react";
import { useDialogs } from "@/components/dialogs";
import { Badge, Button, Checkbox, EmptyState, ErrorNote, Field, Input } from "@/components/ui";
import { api, errorMessage, expectOk, unwrap } from "@/lib/api";
import { money } from "@/lib/format";
import { useQuery } from "@/lib/use-query";

type Group = Awaited<ReturnType<typeof loadGroups>>[number];
type Row = { key: number; id?: string; name: string; price: string; active: boolean };

async function loadGroups() {
  return (await unwrap(await api.v1.restaurant["modifier-groups"].$get({ query: { all: "true" } }))).data;
}

/** Grupos de opciones («Término», «Extras»…) que luego se asignan a los productos. */
export function ModifierGroupsManager({ onChange }: { onChange?: () => void }) {
  const { confirm, toast } = useDialogs();
  const groups = useQuery(useCallback(() => loadGroups(), []));
  const [editing, setEditing] = useState<Group | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (editing) {
    return (
      <GroupEditor
        // Cada grupo abierto parte de cero: sin esto el formulario conservaría el estado del anterior.
        key={editing === "new" ? "new" : editing.id}
        group={editing === "new" ? null : editing}
        onCancel={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          groups.reload();
          onChange?.();
        }}
      />
    );
  }

  async function remove(g: Group) {
    const ok = await confirm({
      title: `Eliminar «${g.name}»`,
      message:
        g.products > 0
          ? `Se quitará de ${g.products} producto${g.products === 1 ? "" : "s"}. Las comandas ya anotadas no cambian.`
          : "Las comandas ya anotadas no cambian.",
      confirmLabel: "Eliminar",
      danger: true,
    });
    if (!ok) return;
    setError(null);
    try {
      await expectOk(
        await api.v1.restaurant["modifier-groups"][":id"].$delete({ param: { id: g.id } }),
      );
      toast("Grupo eliminado");
      groups.reload();
      onChange?.();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setEditing("new")}>Nuevo grupo</Button>
      </div>
      <ErrorNote message={groups.error ?? error} />
      <ul className="divide-y divide-zinc-200 rounded-md border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
        {groups.data?.length === 0 && (
          <EmptyState>Aún no hay grupos. Crea uno, por ejemplo «Término de la carne» o «Extras».</EmptyState>
        )}
        {groups.data?.map((g) => (
          <li key={g.id} className={`space-y-1 px-4 py-3 text-sm ${g.active ? "" : "opacity-60"}`}>
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">
                {g.name}
                {!g.active && (
                  <span className="ml-2">
                    <Badge tone="warning">Inactivo</Badge>
                  </span>
                )}
              </span>
              <span className="flex gap-1">
                <Button variant="ghost" onClick={() => setEditing(g)}>
                  Editar
                </Button>
                <Button variant="ghost" onClick={() => remove(g)}>
                  Eliminar
                </Button>
              </span>
            </div>
            <p className="text-xs text-zinc-600 dark:text-zinc-400">
              {g.modifiers
                .map((m) => (Number(m.price) > 0 ? `${m.name} (+${money(m.price)})` : m.name))
                .join(" · ")}
            </p>
            <p className="text-xs text-zinc-500">
              {g.minSelect > 0 ? `Elegir ${g.minSelect === g.maxSelect ? g.minSelect : `de ${g.minSelect} a ${g.maxSelect}`}` : `Opcional, hasta ${g.maxSelect}`}
              {" · "}
              {g.products} producto{g.products === 1 ? "" : "s"}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

let nextKey = 1;

function GroupEditor({
  group,
  onCancel,
  onSaved,
}: {
  group: Group | null;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const { toast } = useDialogs();
  const [name, setName] = useState(group?.name ?? "");
  const [minSelect, setMin] = useState(String(group?.minSelect ?? 0));
  const [maxSelect, setMax] = useState(String(group?.maxSelect ?? 1));
  const [active, setActive] = useState(group?.active ?? true);
  const [rows, setRows] = useState<Row[]>(
    group?.modifiers.map((m) => ({ key: nextKey++, id: m.id, name: m.name, price: m.price, active: m.active })) ?? [
      { key: nextKey++, name: "", price: "0.00", active: true },
    ],
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const update = (key: number, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    const json = {
      name: name.trim(),
      minSelect: Number(minSelect),
      maxSelect: Number(maxSelect),
      active,
      modifiers: rows
        .filter((r) => r.name.trim())
        .map((r) => ({
          ...(r.id ? { id: r.id } : {}),
          name: r.name.trim(),
          price: (r.price.trim() || "0").replace(",", "."),
          active: r.active,
        })),
    };
    try {
      if (group) {
        await unwrap(
          await api.v1.restaurant["modifier-groups"][":id"].$put({ param: { id: group.id }, json }),
        );
      } else {
        await unwrap(await api.v1.restaurant["modifier-groups"].$post({ json }));
      }
      toast(group ? "Grupo actualizado" : "Grupo creado");
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label="Nombre del grupo">
        <Input value={name} required maxLength={80} placeholder="Término de la carne" onChange={(e) => setName(e.target.value)} />
      </Field>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Mínimo a elegir" hint="0 = opcional; 1 = obligatorio">
          <Input type="number" min={0} max={20} value={minSelect} onChange={(e) => setMin(e.target.value)} />
        </Field>
        <Field label="Máximo a elegir">
          <Input type="number" min={1} max={20} value={maxSelect} onChange={(e) => setMax(e.target.value)} />
        </Field>
      </div>
      <Checkbox label="Grupo activo" checked={active} onChange={(e) => setActive(e.target.checked)} />

      <div className="space-y-2">
        <p className="text-sm font-medium">Opciones</p>
        {rows.map((r) => (
          <div key={r.key} className="flex items-center gap-2">
            <Input
              aria-label="Nombre de la opción"
              placeholder="Nombre"
              maxLength={80}
              value={r.name}
              onChange={(e) => update(r.key, { name: e.target.value })}
            />
            <Input
              aria-label="Recargo"
              className="w-28 text-right"
              inputMode="decimal"
              placeholder="0.00"
              value={r.price}
              onChange={(e) => update(r.key, { price: e.target.value })}
            />
            <label className="flex items-center gap-1 text-xs">
              <input
                type="checkbox"
                aria-label="Opción activa"
                checked={r.active}
                onChange={(e) => update(r.key, { active: e.target.checked })}
              />
              activa
            </label>
            <button
              type="button"
              aria-label="Quitar opción"
              className="text-zinc-500 hover:text-red-600"
              onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}
            >
              ✕
            </button>
          </div>
        ))}
        <Button
          type="button"
          variant="ghost"
          onClick={() => setRows((rs) => [...rs, { key: nextKey++, name: "", price: "0.00", active: true }])}
        >
          Agregar opción
        </Button>
        <p className="text-xs text-zinc-500">El recargo se suma al precio del producto y lleva su mismo impuesto.</p>
      </div>

      <ErrorNote message={error} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onCancel}>
          Volver
        </Button>
        <Button disabled={saving}>{saving ? "Guardando…" : "Guardar"}</Button>
      </div>
    </form>
  );
}
