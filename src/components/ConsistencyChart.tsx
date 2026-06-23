import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";

import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import type { ChartConfig } from "@/components/ui/chart";
import type { EvalRow, MetricKey } from "@/lib/eval-helpers";

const config = {
  eventual: { label: "eventual", color: "var(--chart-2)" },
  strong: { label: "strong", color: "var(--chart-5)" },
} satisfies ChartConfig;

/** Turbopuffer-only: the consistency tax (eventual vs strong) per config. */
export function ConsistencyChart({
  rows,
  metric,
}: {
  rows: EvalRow[];
  metric: MetricKey;
}) {
  const tp = rows.filter((r) => r.service === "turbopuffer");

  // group by mode/topK/iters
  const byConfig = new Map<
    string,
    { config: string; eventual?: number; strong?: number }
  >();
  const MODE_LABEL: Record<string, string> = {
    unfiltered: "unfilt",
    filtered: "filt",
    "filtered-session": "filt-sess",
    "filtered-time": "filt-time",
  };
  for (const r of tp) {
    const key = `${MODE_LABEL[r.mode] ?? r.mode}·k${r.topK}·i${r.iters}`;
    const entry = byConfig.get(key) ?? { config: key };
    if (r.consistency === "eventual") entry.eventual = r[metric];
    if (r.consistency === "strong") entry.strong = r[metric];
    byConfig.set(key, entry);
  }

  const data = [...byConfig.values()];

  return (
    <ChartContainer config={config} className="aspect-auto h-[340px] w-full">
      <BarChart accessibilityLayer data={data} margin={{ left: 4, right: 8, top: 8 }}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="config"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          angle={-30}
          textAnchor="end"
          height={60}
          interval={0}
          fontSize={11}
        />
        <YAxis tickLine={false} axisLine={false} width={40} unit="ms" tickMargin={4} />
        <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="dashed" />} />
        <ChartLegend content={<ChartLegendContent />} />
        <Bar dataKey="eventual" fill="var(--color-eventual)" radius={3} />
        <Bar dataKey="strong" fill="var(--color-strong)" radius={3} />
      </BarChart>
    </ChartContainer>
  );
}
