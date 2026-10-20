"use client";

import { useCallback, useState, type FormEvent } from "react";
import {
  formatDop,
  TAX_CODES,
  TAX_LABELS,
  toCents,
  type TaxCode,
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
  Pagination,
  Select,
  Textarea,
  tableStyles,
} from "@/components/ui";
import { useDialogs } from "@/components/dialogs";
import { usePanel } from "@/components/panel-context";
import { api, errorMessage, expectOk, unwrap } from "@/lib/api";
import { useDebounced, useQuery } from "@/lib/use-query";

const PAGE_SIZE = 20;

type Product = Awaited<ReturnType<typeof loadProducts>>["data"][number];
type Category = { id: string; name: string };

async function loadProducts(params: {
  q: string;
  page: number;
  categoryId: string;
  showInactive: boolean;
}) {
  return unwrap(
    await api.v1.products.$get({
      query: {
        pageSize: String(PAGE_SIZE),
        page: String(params.page),
        ...(params.q ? { q: params.q } : {}),
        ...(params.categoryId ? { categoryId: params.categoryId } : {}),
        ...(params.showInactive ? {} : { active: "true" }),
      },
    }),
  );
}

export function ProductosView() {
  const { canManage } = usePanel();
  const { toast } = useDialogs();
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim());
  const [page, setPage] = useState(1);
  const [categoryId, setCategoryId] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<Product | "new" | null>(null);
  const [categoriesOpen, setCategoriesOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const fetchProducts = useCallback(
    () => loadProducts({ q, page, categoryId, showInactive }),
    [q, page, categoryId, showInactive],
  );
  const products = useQuery(fetchProducts);

  const fetchCategories = useCallback(
    async () => (await unwrap(await api.v1.categories.$get())).data as Category[],
    [],
  );
  const categories = useQuery(fetchCategories);
  const categoryName = (id: string | null) =>
    categories.data?.find((c) => c.id === id)?.name ?? "—";

  async function toggleActive(p: Product) {
    setActionError(null);
    try {
      if (p.active) {
        await expectOk(await api.v1.products[":id"].$delete({ param: { id: p.id } }));
      } else {
        await unwrap(
          await api.v1.products[":id"].$patch({
            param: { id: p.id },
            json: { active: true },
          }),
        );
      }
      toast(p.active ? "Producto desactivado" : "Producto activado");
      products.reload();
    } catch (e) {
      setActionError(errorMessage(e));
    }
  }

  const data = products.data;

  return (
    <>
      <PageHeader
        title="Productos"
        description="Artículos y servicios que vendes. El precio puede incluir o no el impuesto."
        actions={
          canManage && (
            <>
              <Button variant="secondary" onClick={() => setCategoriesOpen(true)}>
                Categorías
              </Button>
              <Button onClick={() => setEditing("new")}>Nuevo producto</Button>
            </>
          )
        }
      />

      <div className="flex flex-wrap items-end gap-3">
        <Field label="Buscar" className="min-w-56 flex-1">
          <Input
            type="search"
            placeholder="Nombre, SKU o código de barras"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        </Field>
        <Field label="Categoría" className="w-48">
          <Select
            value={categoryId}
            onChange={(e) => {
              setCategoryId(e.target.value);
              setPage(1);
            }}
          >
            <option value="">Todas</option>
            {categories.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="pb-2">
          <Checkbox
            label="Mostrar inactivos"
            checked={showInactive}
            onChange={(e) => {
              setShowInactive(e.target.checked);
              setPage(1);
            }}
          />
        </div>
      </div>

      <ErrorNote message={products.error ?? actionError} />

      <div className={tableStyles.wrapper}>
        <table className={tableStyles.table}>
          <thead>
            <tr>
              <th className={tableStyles.th}>Producto</th>
              <th className={tableStyles.th}>Código</th>
              <th className={tableStyles.th}>Categoría</th>
              <th className={tableStyles.th}>Impuesto</th>
              <th className={`${tableStyles.th} text-right`}>Precio</th>
              {canManage && <th className={tableStyles.th} />}
            </tr>
          </thead>
          <tbody>
            {data?.data.map((p) => (
              <tr key={p.id} className={p.active ? "" : "opacity-60"}>
                <td className={tableStyles.td}>
                  <span className="font-medium">{p.name}</span>
                  {!p.active && (
                    <span className="ml-2">
                      <Badge tone="warning">Inactivo</Badge>
                    </span>
                  )}
                </td>
                <td className={`${tableStyles.td} font-mono text-xs text-zinc-500`}>
                  {p.barcode ?? p.sku ?? "—"}
                </td>
                <td className={tableStyles.td}>{categoryName(p.categoryId)}</td>
                <td className={tableStyles.td}>
                  <Badge>{TAX_LABELS[p.tax as TaxCode]}</Badge>
                  {p.trackInventory && (
                    <span className="ml-1">
                      <Badge tone="success">Inventario</Badge>
                    </span>
                  )}
                </td>
                <td className={`${tableStyles.td} text-right tabular-nums`}>
                  {formatDop(toCents(p.price))}
                  <span className="text-xs text-zinc-500"> /{p.unit}</span>
                  <div className="text-xs text-zinc-500">
                    {p.priceIncludesTax ? "con impuesto" : "sin impuesto"}
                  </div>
                  {p.lastCost && (
                    <div className="text-xs text-zinc-500">
                      costo {formatDop(toCents(p.lastCost))}
                    </div>
                  )}
                </td>
                {canManage && (
                  <td className={`${tableStyles.td} whitespace-nowrap text-right`}>
                    <Button variant="ghost" onClick={() => setEditing(p)}>
                      Editar
                    </Button>
                    <Button variant="ghost" onClick={() => toggleActive(p)}>
                      {p.active ? "Desactivar" : "Activar"}
                    </Button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {data && data.data.length === 0 && (
          <EmptyState>
            {q || categoryId
              ? "Ningún producto coincide con la búsqueda."
              : "Aún no hay productos."}
          </EmptyState>
        )}
        {!data && !products.error && <EmptyState>Cargando…</EmptyState>}
      </div>

      {data && (
        <Pagination
          page={data.page}
          pageSize={data.pageSize}
          total={data.total}
          onPage={setPage}
        />
      )}

      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === "new" ? "Nuevo producto" : "Editar producto"}
      >
        {editing && (
          <ProductForm
            product={editing === "new" ? null : editing}
            categories={categories.data ?? []}
            onDone={() => {
              setEditing(null);
              products.reload();
            }}
          />
        )}
      </Modal>

      <Modal
        open={categoriesOpen}
        onClose={() => setCategoriesOpen(false)}
        title="Categorías"
      >
        {categoriesOpen && (
          <CategoriesManager
            categories={categories.data ?? []}
            onChange={categories.reload}
          />
        )}
      </Modal>
    </>
  );
}

function ProductForm({
  product,
  categories,
  onDone,
}: {
  product: Product | null;
  categories: Category[];
  onDone: () => void;
}) {
  const { toast } = useDialogs();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [track, setTrack] = useState(product?.trackInventory ?? false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    const f = new FormData(e.currentTarget);
    const text = (name: string) => String(f.get(name) ?? "").trim();

    const json = {
      name: text("name"),
      price: text("price").replace(",", "."),
      description: text("description"),
      sku: text("sku"),
      barcode: text("barcode"),
      categoryId: text("categoryId") || null,
      tax: text("tax") as TaxCode,
      unit: text("unit") || "UND",
      priceIncludesTax: f.get("priceIncludesTax") === "on",
      allowsDecimals: f.get("allowsDecimals") === "on",
      prepStation: text("prepStation") as "NONE" | "KITCHEN" | "BAR",
      trackInventory: track,
      minStock: track ? text("minStock").replace(",", ".") || "0" : "0",
    };

    try {
      if (product) {
        await unwrap(
          await api.v1.products[":id"].$patch({ param: { id: product.id }, json }),
        );
      } else {
        await unwrap(await api.v1.products.$post({ json }));
      }
      toast(product ? "Producto actualizado" : "Producto creado");
      onDone();
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <Field label="Nombre">
        <Input
          name="name"
          required
          maxLength={200}
          defaultValue={product?.name}
          autoFocus
        />
      </Field>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Precio (RD$)">
          <Input
            name="price"
            required
            inputMode="decimal"
            placeholder="0.00"
            defaultValue={product?.price}
          />
        </Field>
        <Field label="Impuesto">
          <Select name="tax" defaultValue={product?.tax ?? "ITBIS18"}>
            {TAX_CODES.map((code) => (
              <option key={code} value={code}>
                {TAX_LABELS[code]}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Checkbox
        name="priceIncludesTax"
        label="El precio ya incluye el impuesto"
        defaultChecked={product?.priceIncludesTax ?? true}
      />
      <div className="grid grid-cols-2 gap-4">
        <Field label="Código de barras">
          <Input name="barcode" defaultValue={product?.barcode ?? ""} />
        </Field>
        <Field label="SKU">
          <Input name="sku" defaultValue={product?.sku ?? ""} />
        </Field>
        <Field label="Categoría">
          <Select name="categoryId" defaultValue={product?.categoryId ?? ""}>
            <option value="">Sin categoría</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Unidad" hint="UND, LB, KG, HORA…">
          <Input name="unit" maxLength={10} defaultValue={product?.unit ?? "UND"} />
        </Field>
      </div>
      <Checkbox
        name="allowsDecimals"
        label="Se vende por peso o fracciones (acepta decimales)"
        defaultChecked={product?.allowsDecimals ?? false}
      />
      <div className="space-y-3 rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
        <Checkbox
          label="Controlar inventario (se descuenta al emitir una factura)"
          checked={track}
          onChange={(e) => setTrack(e.target.checked)}
        />
        {track && (
          <Field
            label="Existencia mínima"
            hint="Se avisa cuando la existencia llegue a esta cantidad"
          >
            <Input
              name="minStock"
              inputMode="decimal"
              defaultValue={product?.minStock ?? "0"}
            />
          </Field>
        )}
      </div>
      <Field
        label="Estación de preparación"
        hint="En restaurantes: a dónde se envía el pedido al anotarlo en una mesa"
      >
        <Select name="prepStation" defaultValue={product?.prepStation ?? "NONE"}>
          <option value="NONE">No se prepara (sale directo)</option>
          <option value="KITCHEN">Cocina</option>
          <option value="BAR">Bar</option>
        </Select>
      </Field>
      <Field label="Descripción">
        <Textarea name="description" rows={2} defaultValue={product?.description ?? ""} />
      </Field>
      <ErrorNote message={error} />
      <div className="flex justify-end">
        <Button disabled={saving}>{saving ? "Guardando…" : "Guardar"}</Button>
      </div>
    </form>
  );
}

function CategoriesManager({
  categories,
  onChange,
}: {
  categories: Category[];
  onChange: () => void;
}) {
  const { confirm, prompt, toast } = useDialogs();
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
      onChange();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const name = String(new FormData(form).get("name") ?? "").trim();
    await run(async () => {
      await unwrap(await api.v1.categories.$post({ json: { name } }));
      form.reset();
    });
  }

  return (
    <div className="space-y-4">
      <form onSubmit={add} className="flex gap-2">
        <Input name="name" required maxLength={80} placeholder="Nueva categoría" />
        <Button>Agregar</Button>
      </form>
      <ErrorNote message={error} />
      <ul className="divide-y divide-zinc-200 rounded-md border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
        {categories.length === 0 && <EmptyState>Sin categorías.</EmptyState>}
        {categories.map((c) => (
          <li
            key={c.id}
            className="flex items-center justify-between gap-2 px-4 py-2 text-sm"
          >
            <span>{c.name}</span>
            <span className="flex gap-1">
              <Button
                variant="ghost"
                onClick={async () => {
                  const name = await prompt({
                    title: "Renombrar categoría",
                    label: "Nombre",
                    initialValue: c.name,
                    confirmLabel: "Guardar",
                  });
                  if (name && name !== c.name) {
                    await run(async () =>
                      unwrap(
                        await api.v1.categories[":id"].$patch({
                          param: { id: c.id },
                          json: { name },
                        }),
                      ),
                    );
                    toast("Categoría renombrada");
                  }
                }}
              >
                Renombrar
              </Button>
              <Button
                variant="ghost"
                onClick={async () => {
                  const ok = await confirm({
                    title: `Eliminar "${c.name}"`,
                    message: "Sus productos quedarán sin categoría.",
                    confirmLabel: "Eliminar",
                    danger: true,
                  });
                  if (ok) {
                    await run(async () =>
                      expectOk(
                        await api.v1.categories[":id"].$delete({ param: { id: c.id } }),
                      ),
                    );
                    toast("Categoría eliminada");
                  }
                }}
              >
                Eliminar
              </Button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
