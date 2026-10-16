"use client";

import Link from "next/link";
import { useCallback } from "react";
import { ErrorNote, PageHeader } from "@/components/ui";
import { usePanel } from "@/components/panel-context";
import { api, unwrap } from "@/lib/api";
import { useQuery } from "@/lib/use-query";

export function ResumenView() {
  const { organizationName } = usePanel();

  const load = useCallback(async () => {
    const [products, customers, branches, terminals] = await Promise.all([
      unwrap(await api.v1.products.$get({ query: { pageSize: "1", active: "true" } })),
      unwrap(await api.v1.customers.$get({ query: { pageSize: "1", active: "true" } })),
      unwrap(await api.v1.branches.$get()),
      unwrap(await api.v1.terminals.$get({ query: {} })),
    ]);
    return {
      products: products.total,
      customers: customers.total,
      branches: branches.data.length,
      terminals: terminals.data.length,
    };
  }, []);
  const { data, error } = useQuery(load);

  const cards = [
    { label: "Productos activos", value: data?.products, href: "/panel/productos" },
    { label: "Clientes", value: data?.customers, href: "/panel/clientes" },
    { label: "Sucursales", value: data?.branches, href: "/panel/sucursales" },
    { label: "Cajas", value: data?.terminals, href: "/panel/sucursales" },
  ];

  return (
    <>
      <PageHeader title={organizationName || "Resumen"} description="Estado general de tu empresa." />
      <ErrorNote message={error} />
      <section className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {cards.map((c) => (
          <Link
            key={c.label}
            href={c.href}
            className="rounded-lg border border-zinc-200 p-4 transition hover:border-zinc-400 dark:border-zinc-800 dark:hover:border-zinc-600"
          >
            <p className="text-3xl font-semibold tabular-nums">{c.value ?? "–"}</p>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{c.label}</p>
          </Link>
        ))}
      </section>
      {data && data.branches === 0 && (
        <p className="rounded-md bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          Empieza creando tu primera sucursal y caja en{" "}
          <Link href="/panel/sucursales" className="font-medium underline">
            Sucursales y cajas
          </Link>
          .
        </p>
      )}
    </>
  );
}
