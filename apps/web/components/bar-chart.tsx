export type BarDatum = { label: string; value: number; title: string };

/**
 * Gráfico de barras mínimo (sin dependencias). Las barras tienen `title` para ver el detalle
 * al pasar el cursor y la tabla de datos va siempre junto al gráfico, así que no es la única fuente.
 */
export function BarChart({ data, height = 140 }: { data: BarDatum[]; height?: number }) {
  const max = Math.max(...data.map((d) => d.value), 0);
  if (data.length === 0 || max <= 0) {
    return (
      <p className="py-8 text-center text-sm text-zinc-500">
        Sin ventas en este período.
      </p>
    );
  }
  const labelEvery = Math.ceil(data.length / 10);
  return (
    <div
      role="img"
      aria-label="Gráfico de ventas por período"
      className="flex items-end gap-1"
      style={{ height }}
    >
      {data.map((d, i) => (
        <div
          key={d.label}
          className="flex h-full min-w-0 flex-1 flex-col justify-end gap-1"
          title={d.title}
        >
          <div
            className="w-full rounded-t bg-foreground/80"
            style={{ height: `${Math.max((d.value / max) * 100, d.value > 0 ? 2 : 0)}%` }}
          />
          <span className="h-4 truncate text-center text-[10px] text-zinc-500">
            {i % labelEvery === 0 ? d.label : ""}
          </span>
        </div>
      ))}
    </div>
  );
}
