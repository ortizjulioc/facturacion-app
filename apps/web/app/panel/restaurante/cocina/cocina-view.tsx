"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { Button, EmptyState, ErrorNote, PageHeader } from "@/components/ui";
import { api, errorMessage, expectOk, unwrap } from "@/lib/api";
import { useInterval } from "@/lib/use-interval";
import { useQuery } from "@/lib/use-query";

type Station = "KITCHEN" | "BAR";

const STATIONS: { value: Station; label: string }[] = [
  { value: "KITCHEN", label: "Cocina" },
  { value: "BAR", label: "Bar" },
];

const linkButton =
  "inline-flex items-center justify-center rounded-md border border-zinc-300 px-3.5 py-2 text-sm font-medium transition hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900";

function waiting(iso: string | Date | null) {
  if (!iso) return { text: "", late: false };
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60_000));
  return { text: minutes < 1 ? "ahora" : `${minutes} min`, late: minutes >= 15 };
}

export function CocinaView() {
  const [station, setStation] = useState<Station>("KITCHEN");
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyItem, setBusyItem] = useState<string | null>(null);

  const queue = useQuery(
    useCallback(
      async () => (await unwrap(await api.v1.restaurant.kitchen.$get({ query: { station } }))).data,
      [station],
    ),
  );
  // La pantalla se refresca sola para ver los pedidos nuevos sin tocar nada.
  useInterval(queue.reload, 8_000);

  async function ready(itemId: string) {
    setActionError(null);
    setBusyItem(itemId);
    try {
      await expectOk(await api.v1.restaurant.items[":id"].ready.$post({ param: { id: itemId } }));
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setBusyItem(null);
      queue.reload();
    }
  }

  const groups = queue.data ?? [];

  return (
    <>
      <PageHeader
        title="Cocina y bar"
        description="Pedidos enviados desde las mesas, del más antiguo al más reciente."
        actions={
          <Link href="/panel/restaurante" className={linkButton}>
            Volver al salón
          </Link>
        }
      />

      <div role="tablist" className="flex gap-2">
        {STATIONS.map((s) => (
          <Button
            key={s.value}
            role="tab"
            aria-selected={station === s.value}
            variant={station === s.value ? "primary" : "secondary"}
            onClick={() => setStation(s.value)}
          >
            {s.label}
          </Button>
        ))}
      </div>

      <ErrorNote message={queue.error ?? actionError} />

      {queue.data && groups.length === 0 && <EmptyState>No hay pedidos pendientes.</EmptyState>}
      {!queue.data && !queue.error && <EmptyState>Cargando…</EmptyState>}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {groups.map((g) => {
          const w = waiting(g.sentAt);
          return (
            <section
              key={g.orderId}
              className={`space-y-3 rounded-lg border p-4 ${
                w.late
                  ? "border-red-400 bg-red-50 dark:border-red-800 dark:bg-red-950/30"
                  : "border-zinc-200 dark:border-zinc-800"
              }`}
            >
              <header className="flex items-baseline justify-between gap-2">
                <h2 className="font-semibold">
                  {g.table}
                  {g.zone && <span className="font-normal text-zinc-500"> · {g.zone}</span>}
                </h2>
                <span className="text-xs text-zinc-500">
                  #{g.number} · {w.text}
                </span>
              </header>
              <ul className="space-y-2">
                {g.items.map((i) => (
                  <li key={i.id} className="flex items-start justify-between gap-2">
                    <div className="text-sm">
                      <span className="font-semibold tabular-nums">{i.quantity}×</span> {i.name}
                      {i.notes && (
                        <p className="text-xs font-medium text-amber-700 dark:text-amber-400">
                          {i.notes}
                        </p>
                      )}
                    </div>
                    <Button
                      variant="secondary"
                      disabled={busyItem === i.id}
                      onClick={() => ready(i.id)}
                    >
                      Listo
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </>
  );
}
