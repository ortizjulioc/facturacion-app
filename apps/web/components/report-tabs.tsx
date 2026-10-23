import Link from "next/link";

const TABS = [
  { id: "ventas", label: "Ventas", href: "/panel/reportes" },
  { id: "compras", label: "Compras (606)", href: "/panel/reportes/compras" },
  { id: "dgii", label: "Formatos DGII", href: "/panel/reportes/dgii" },
] as const;

/** Pestañas entre los reportes de ventas y compras y los formatos de la DGII. */
export function ReportTabs({ active }: { active: (typeof TABS)[number]["id"] }) {
  return (
    <nav
      aria-label="Reportes"
      className="flex gap-1 border-b border-zinc-200 dark:border-zinc-800"
    >
      {TABS.map((t) => (
        <Link
          key={t.id}
          href={t.href}
          aria-current={active === t.id ? "page" : undefined}
          className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${
            active === t.id
              ? "border-foreground text-foreground"
              : "border-transparent text-zinc-600 hover:text-foreground dark:text-zinc-400"
          }`}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
