import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";

import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import {
  metricChartConfig,
  SERVICE_LABEL,
  type EvalRow,
  type MetricKey,
} from "@/lib/eval-helpers";

export function LatencyByServiceChart({
  rows,
  metrics,
}: {
  rows: EvalRow[];
  metrics: MetricKey[];
}) {
  const data = rows.map((r) => ({
    service: SERVICE_LABEL[r.service],
    avg: r.avg,
    p50: r.p50,
    p95: r.p95,
    max: r.max,
  }));

  return (
    <ChartContainer config={metricChartConfig} className="aspect-auto h-[320px] w-full">
      <BarChart accessibilityLayer data={data} margin={{ left: 4, right: 8, top: 8 }}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="service"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={40}
          unit="ms"
          tickMargin={4}
        />
        <ChartTooltip
          cursor={false}
          content={<ChartTooltipContent indicator="dashed" />}
        />
        <ChartLegend content={<ChartLegendContent />} />
        {metrics.map((m) => (
          <Bar key={m} dataKey={m} fill={`var(--color-${m})`} radius={3} />
        ))}
      </BarChart>
    </ChartContainer>
  );
}
