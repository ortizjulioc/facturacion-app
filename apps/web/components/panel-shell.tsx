"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { DialogProvider } from "@/components/dialogs";
import { PanelContext } from "@/components/panel-context";
import { authClient } from "@/lib/api";

const NAV: { href: string; label: string; adminOnly?: boolean }[] = [
  { href: "/panel", label: "Resumen" },
  { href: "/panel/facturas", label: "Facturas" },
  { href: "/panel/turnos", label: "Turnos de caja" },
  { href: "/panel/reportes", label: "Reportes", adminOnly: true },
  { href: "/panel/restaurante", label: "Restaurante" },
  { href: "/panel/productos", label: "Productos" },
  { href: "/panel/inventario", label: "Inventario" },
  { href: "/panel/compras", label: "Compras", adminOnly: true },
  { href: "/panel/proveedores", label: "Proveedores", adminOnly: true },
  { href: "/panel/clientes", label: "Clientes" },
  { href: "/panel/sucursales", label: "Sucursales y cajas" },
  { href: "/panel/fiscal", label: "Configuración fiscal" },
  { href: "/panel/equipo", label: "Equipo" },
];

export function PanelShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { data: session, isPending } = authClient.useSession();
  const { data: org } = authClient.useActiveOrganization();
  const { data: member } = authClient.useActiveMember();

  useEffect(() => {
    if (!isPending && !session) router.replace("/login");
  }, [isPending, session, router]);

  if (isPending || !session) {
    return <p className="p-8 text-sm text-zinc-500">Cargando…</p>;
  }

  const roles = (member?.role ?? "").split(",").map((r) => r.trim());
  const canManage = roles.includes("owner") || roles.includes("admin");

  async function signOut() {
    await authClient.signOut();
    router.push("/login");
  }

  return (
    <PanelContext.Provider value={{ organizationName: org?.name ?? "", canManage }}>
      <DialogProvider>
        <div className="flex min-h-screen flex-col md:flex-row">
          <aside className="no-print flex shrink-0 flex-col gap-6 border-b border-zinc-200 p-4 md:w-60 md:border-r md:border-b-0 dark:border-zinc-800">
            <div>
              <p className="text-xs uppercase tracking-wide text-zinc-500">Empresa</p>
              <p className="truncate font-semibold">{org?.name ?? "—"}</p>
            </div>
            <nav className="flex flex-row gap-1 overflow-x-auto md:flex-col">
              {NAV.filter((item) => !item.adminOnly || canManage).map((item) => {
                const active =
                  item.href === "/panel"
                    ? pathname === "/panel"
                    : pathname.startsWith(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={`whitespace-nowrap rounded-md px-3 py-2 text-sm ${
                      active
                        ? "bg-foreground font-medium text-background"
                        : "hover:bg-zinc-100 dark:hover:bg-zinc-900"
                    }`}
                  >
                    {item.label}
                  </Link>
                );
              })}
            </nav>
            <div className="mt-auto space-y-1 text-sm">
              <p className="truncate text-zinc-600 dark:text-zinc-400">
                {session.user.email}
              </p>
              <button onClick={signOut} className="underline">
                Cerrar sesión
              </button>
            </div>
          </aside>
          <main className="mx-auto w-full max-w-5xl flex-1 space-y-6 p-6 md:p-10">
            {children}
          </main>
        </div>
      </DialogProvider>
    </PanelContext.Provider>
  );
}
