import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";

import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import {
  rowsForConfig,
  serviceChartConfig,
  SERVICES,
  topKsIn,
  type Consistency,
  type EvalRow,
  type MetricKey,
  type Mode,
} from "@/lib/eval-helpers";

/** One line per service: how the chosen metric scales with topK. */
export function ScalingChart({
  rows,
  mode,
  iters,
  tpConsistency,
  metric,
}: {
  rows: EvalRow[];
  mode: Mode;
  iters: number;
  tpConsistency: Consistency;
  metric: MetricKey;
}) {
  const topKs = topKsIn(rows);

  const data = topKs.map((topK) => {
    const selected = rowsForConfig(rows, { mode, topK, iters, tpConsistency });
    const point: Record<string, number | string> = { topK: `top ${topK}` };
    for (const r of selected) point[r.service] = r[metric];
    return point;
  });

  return (
    <ChartContainer config={serviceChartConfig} className="aspect-auto h-[320px] w-full">
      <LineChart accessibilityLayer data={data} margin={{ left: 4, right: 12, top: 8 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="topK" tickLine={false} axisLine={false} tickMargin={8} />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={40}
          unit="ms"
          tickMargin={4}
        />
        <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
        <ChartLegend content={<ChartLegendContent />} />
        {SERVICES.map((s) => (
          <Line
            key={s}
            dataKey={s}
            type="monotone"
            stroke={`var(--color-${s})`}
            strokeWidth={2}
            dot={{ r: 3 }}
            activeDot={{ r: 5 }}
            connectNulls
          />
        ))}
      </LineChart>
    </ChartContainer>
  );
}
