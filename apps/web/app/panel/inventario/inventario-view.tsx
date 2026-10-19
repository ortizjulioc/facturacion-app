"use client";

import { useCallback, useState, type FormEvent } from "react";
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
  tableStyles,
} from "@/components/ui";
import { useDialogs } from "@/components/dialogs";
import { usePanel } from "@/components/panel-context";
import { api, errorMessage, unwrap } from "@/lib/api";
import { formatDateTime, money } from "@/lib/format";
import { useDebounced, useQuery } from "@/lib/use-query";

const PAGE_SIZE = 20;

const MOVEMENT_LABELS: Record<string, string> = {
  RECEIPT: "Entrada",
  SALE: "Venta",
  RETURN: "Reingreso",
  ADJUSTMENT: "Ajuste",
};

async function loadStock(p: { q: string; page: number; branchId: string; low: boolean }) {
  return unwrap(
    await api.v1.inventory.stock.$get({
      query: {
        page: String(p.page),
        pageSize: String(PAGE_SIZE),
        ...(p.q ? { q: p.q } : {}),
        ...(p.branchId ? { branchId: p.branchId } : {}),
        ...(p.low ? { low: "true" as const } : {}),
      },
    }),
  );
}
type StockRow = Awaited<ReturnType<typeof loadStock>>["data"][number];

async function loadMovements(p: { page: number; branchId: string; type: string }) {
  return unwrap(
    await api.v1.inventory.movements.$get({
      query: {
        page: String(p.page),
        pageSize: String(PAGE_SIZE),
        ...(p.branchId ? { branchId: p.branchId } : {}),
        ...(p.type
          ? { type: p.type as "RECEIPT" | "SALE" | "RETURN" | "ADJUSTMENT" }
          : {}),
      },
    }),
  );
}

async function loadSetup() {
  const [branches, settings] = await Promise.all([
    unwrap(await api.v1.branches.$get()),
    unwrap(await api.v1.inventory.settings.$get()),
  ]);
  return { branches: branches.data.filter((b) => b.active), settings: settings.data };
}

export function InventarioView({ initialLowOnly = false }: { initialLowOnly?: boolean }) {
  const { canManage } = usePanel();
  const { toast } = useDialogs();
  const setup = useQuery(loadSetup);

  const [tab, setTab] = useState<"stock" | "movements">("stock");
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim());
  const [page, setPage] = useState(1);
  const [branchId, setBranchId] = useState("");
  const [lowOnly, setLowOnly] = useState(initialLowOnly);
  const [moveType, setMoveType] = useState("");
  const [receiptFor, setReceiptFor] = useState<StockRow | null>(null);
  const [adjustFor, setAdjustFor] = useState<StockRow | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const fetchStock = useCallback(
    () => loadStock({ q, page, branchId, low: lowOnly }),
    [q, page, branchId, lowOnly],
  );
  const stock = useQuery(fetchStock);
  const fetchMovements = useCallback(
    () => loadMovements({ page, branchId, type: moveType }),
    [page, branchId, moveType],
  );
  const movements = useQuery(fetchMovements);

  const branches = setup.data?.branches ?? [];
  const settings = setup.data?.settings;
  // Para entradas y ajustes hace falta una sucursal concreta.
  const actionBranch = branchId || branches[0]?.id || "";

  async function toggleNegative(allow: boolean) {
    setActionError(null);
    try {
      await unwrap(
        await api.v1.inventory.settings.$patch({ json: { allowNegativeStock: allow } }),
      );
      toast(
        allow
          ? "Se permite vender sin existencia"
          : "Ya no se puede vender sin existencia",
      );
      setup.reload();
    } catch (e) {
      setActionError(errorMessage(e));
    }
  }

  const reloadAll = () => {
    stock.reload();
    movements.reload();
  };

  const data = tab === "stock" ? stock.data : movements.data;

  return (
    <>
      <PageHeader
        title="Inventario"
        description="Existencias por sucursal. Al emitir una factura se descuentan los productos que controlan inventario."
      />

      <div className="flex flex-wrap items-end gap-3">
        <div
          role="tablist"
          className="flex rounded-md border border-zinc-300 p-0.5 dark:border-zinc-700"
        >
          {(["stock", "movements"] as const).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              onClick={() => {
                setTab(t);
                setPage(1);
              }}
              className={`rounded px-3 py-1.5 text-sm font-medium ${
                tab === t
                  ? "bg-foreground text-background"
                  : "text-zinc-600 dark:text-zinc-400"
              }`}
            >
              {t === "stock" ? "Existencias" : "Movimientos"}
            </button>
          ))}
        </div>
        <Field label="Sucursal" className="w-48">
          <Select
            value={branchId}
            onChange={(e) => {
              setBranchId(e.target.value);
              setPage(1);
            }}
          >
            <option value="">Todas (suma)</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        </Field>
        {tab === "stock" ? (
          <>
            <Field label="Buscar" className="min-w-52 flex-1">
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
            <div className="pb-2">
              <Checkbox
                label="Solo stock bajo o agotado"
                checked={lowOnly}
                onChange={(e) => {
                  setLowOnly(e.target.checked);
                  setPage(1);
                }}
              />
            </div>
          </>
        ) : (
          <Field label="Tipo" className="w-44">
            <Select
              value={moveType}
              onChange={(e) => {
                setMoveType(e.target.value);
                setPage(1);
              }}
            >
              <option value="">Todos</option>
              {Object.entries(MOVEMENT_LABELS).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </div>

      {canManage && settings && (
        <div className="rounded-md border border-zinc-200 px-4 py-3 text-sm dark:border-zinc-800">
          <Checkbox
            label="Permitir emitir facturas aunque falte existencia (el saldo queda en negativo)"
            checked={settings.allowNegativeStock}
            disabled={!settings.configured}
            onChange={(e) => toggleNegative(e.target.checked)}
          />
          {!settings.configured && (
            <p className="mt-1 text-xs text-zinc-500">
              Registra primero los datos fiscales de la empresa para cambiar esto.
            </p>
          )}
        </div>
      )}

      <ErrorNote
        message={(tab === "stock" ? stock.error : movements.error) ?? actionError}
      />

      {tab === "stock" ? (
        <div className={tableStyles.wrapper}>
          <table className={tableStyles.table}>
            <thead>
              <tr>
                <th className={tableStyles.th}>Producto</th>
                <th className={`${tableStyles.th} text-right`}>Existencia</th>
                <th className={`${tableStyles.th} text-right`}>Mínimo</th>
                <th className={tableStyles.th}>Estado</th>
                {canManage && <th className={tableStyles.th} />}
              </tr>
            </thead>
            <tbody>
              {stock.data?.data.map((r) => (
                <tr key={r.productId}>
                  <td className={tableStyles.td}>
                    <span className="font-medium">{r.name}</span>
                    <div className="font-mono text-xs text-zinc-500">
                      {r.barcode ?? r.sku ?? ""}
                    </div>
                  </td>
                  <td className={`${tableStyles.td} text-right tabular-nums`}>
                    {r.quantity} <span className="text-xs text-zinc-500">{r.unit}</span>
                  </td>
                  <td
                    className={`${tableStyles.td} text-right tabular-nums text-zinc-500`}
                  >
                    {r.minStock}
                  </td>
                  <td className={tableStyles.td}>
                    {r.status === "OUT" ? (
                      <Badge tone="warning">Agotado</Badge>
                    ) : r.status === "LOW" ? (
                      <Badge tone="warning">Stock bajo</Badge>
                    ) : (
                      <Badge tone="success">Disponible</Badge>
                    )}
                  </td>
                  {canManage && (
                    <td className={`${tableStyles.td} whitespace-nowrap text-right`}>
                      <Button
                        variant="ghost"
                        disabled={!actionBranch}
                        onClick={() => setReceiptFor(r)}
                      >
                        Entrada
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={!actionBranch}
                        onClick={() => setAdjustFor(r)}
                      >
                        Ajustar
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {stock.data && stock.data.data.length === 0 && (
            <EmptyState>
              {q || lowOnly
                ? "Ningún producto coincide."
                : "Aún no hay productos con control de inventario. Actívalo en la ficha del producto."}
            </EmptyState>
          )}
          {!stock.data && !stock.error && <EmptyState>Cargando…</EmptyState>}
        </div>
      ) : (
        <div className={tableStyles.wrapper}>
          <table className={tableStyles.table}>
            <thead>
              <tr>
                <th className={tableStyles.th}>Fecha</th>
                <th className={tableStyles.th}>Producto</th>
                <th className={tableStyles.th}>Tipo</th>
                <th className={`${tableStyles.th} text-right`}>Cantidad</th>
                <th className={`${tableStyles.th} text-right`}>Saldo</th>
                <th className={tableStyles.th}>Detalle</th>
              </tr>
            </thead>
            <tbody>
              {movements.data?.data.map((m) => (
                <tr key={m.id}>
                  <td className={`${tableStyles.td} whitespace-nowrap`}>
                    {formatDateTime(m.createdAt)}
                  </td>
                  <td className={tableStyles.td}>
                    {m.product.name}
                    <div className="text-xs text-zinc-500">{m.branch.name}</div>
                  </td>
                  <td className={tableStyles.td}>
                    <Badge>{MOVEMENT_LABELS[m.type] ?? m.type}</Badge>
                  </td>
                  <td
                    className={`${tableStyles.td} text-right tabular-nums ${
                      m.quantity.startsWith("-") ? "text-red-600" : "text-emerald-600"
                    }`}
                  >
                    {m.quantity.startsWith("-") ? m.quantity : `+${m.quantity}`}
                  </td>
                  <td className={`${tableStyles.td} text-right tabular-nums`}>
                    {m.balanceAfter}
                  </td>
                  <td
                    className={`${tableStyles.td} text-sm text-zinc-600 dark:text-zinc-400`}
                  >
                    {m.document?.encf && (
                      <span className="font-mono text-xs">{m.document.encf} </span>
                    )}
                    {m.reason}
                    {m.unitCost && (
                      <span className="text-xs"> · costo {money(m.unitCost)}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {movements.data && movements.data.data.length === 0 && (
            <EmptyState>Sin movimientos.</EmptyState>
          )}
          {!movements.data && !movements.error && <EmptyState>Cargando…</EmptyState>}
        </div>
      )}

      {data && (
        <Pagination
          page={data.page}
          pageSize={data.pageSize}
          total={data.total}
          onPage={setPage}
        />
      )}

      <Modal
        open={receiptFor !== null}
        onClose={() => setReceiptFor(null)}
        title={`Entrada de ${receiptFor?.name ?? ""}`}
      >
        {receiptFor && (
          <MovementForm
            kind="receipt"
            product={receiptFor}
            branches={branches}
            defaultBranch={actionBranch}
            onDone={(msg) => {
              setReceiptFor(null);
              toast(msg);
              reloadAll();
            }}
          />
        )}
      </Modal>
      <Modal
        open={adjustFor !== null}
        onClose={() => setAdjustFor(null)}
        title={`Ajustar ${adjustFor?.name ?? ""}`}
      >
        {adjustFor && (
          <MovementForm
            kind="adjustment"
            product={adjustFor}
            branches={branches}
            defaultBranch={actionBranch}
            onDone={(msg) => {
              setAdjustFor(null);
              toast(msg);
              reloadAll();
            }}
          />
        )}
      </Modal>
    </>
  );
}

function MovementForm({
  kind,
  product,
  branches,
  defaultBranch,
  onDone,
}: {
  kind: "receipt" | "adjustment";
  product: StockRow;
  branches: { id: string; name: string }[];
  defaultBranch: string;
  onDone: (message: string) => void;
}) {
  const [mode, setMode] = useState<"delta" | "count">("delta");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    const f = new FormData(e.currentTarget);
    const text = (name: string) =>
      String(f.get(name) ?? "")
        .trim()
        .replace(",", ".");
    const branch = text("branchId");
    try {
      if (kind === "receipt") {
        const res = await unwrap(
          await api.v1.inventory.receipts.$post({
            json: {
              productId: product.productId,
              branchId: branch,
              quantity: text("quantity"),
              ...(text("unitCost") ? { unitCost: text("unitCost") } : {}),
              reason: String(f.get("reason") ?? "").trim(),
            },
          }),
        );
        onDone(`Entrada registrada. Existencia: ${res.data.balance}`);
      } else {
        const res = await unwrap(
          await api.v1.inventory.adjustments.$post({
            json: {
              productId: product.productId,
              branchId: branch,
              mode,
              quantity: text("quantity"),
              reason: String(f.get("reason") ?? "").trim(),
            },
          }),
        );
        onDone(`Ajuste registrado (${res.data.delta}). Existencia: ${res.data.balance}`);
      }
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <Field label="Sucursal">
        <Select name="branchId" defaultValue={defaultBranch}>
          {branches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </Select>
      </Field>
      {kind === "adjustment" && (
        <Field
          label="Tipo de ajuste"
          hint={
            mode === "delta"
              ? "Escribe cuánto sumar (positivo) o restar (negativo)."
              : "Escribe lo que contaste: se ajusta la diferencia."
          }
        >
          <Select
            value={mode}
            onChange={(e) => setMode(e.target.value as "delta" | "count")}
          >
            <option value="delta">Sumar o restar</option>
            <option value="count">Fijar la existencia contada</option>
          </Select>
        </Field>
      )}
      <div className="grid grid-cols-2 gap-4">
        <Field
          label={
            kind === "receipt"
              ? `Cantidad (${product.unit})`
              : mode === "count"
                ? "Cantidad contada"
                : "Cantidad (+/−)"
          }
        >
          <Input name="quantity" required inputMode="decimal" placeholder="0" autoFocus />
        </Field>
        {kind === "receipt" && (
          <Field label="Costo unitario (RD$)" hint="Opcional">
            <Input name="unitCost" inputMode="decimal" placeholder="0.00" />
          </Field>
        )}
      </div>
      <Field
        label={
          kind === "receipt" ? "Motivo o referencia (opcional)" : "Motivo del ajuste"
        }
      >
        <Input
          name="reason"
          required={kind === "adjustment"}
          minLength={kind === "adjustment" ? 3 : undefined}
          maxLength={250}
          placeholder={
            kind === "receipt"
              ? "Compra a proveedor, factura #…"
              : "Conteo físico, merma, daño…"
          }
        />
      </Field>
      <ErrorNote message={error} />
      <div className="flex justify-end">
        <Button disabled={saving}>{saving ? "Guardando…" : "Registrar"}</Button>
      </div>
    </form>
  );
}
