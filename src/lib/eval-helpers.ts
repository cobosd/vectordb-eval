import type { Consistency, EvalRow, Mode, Service } from "./eval-data";
import type { ChartConfig } from "@/components/ui/chart";

export type { Consistency, EvalRow, Mode, Service };

export const SERVICES: Service[] = [
  "turbopuffer",
  "pinecone",
  "qdrant",
  "opensearch",
];

export const SERVICE_LABEL: Record<Service, string> = {
  turbopuffer: "Turbopuffer",
  pinecone: "Pinecone",
  qdrant: "Qdrant",
  opensearch: "OpenSearch",
};

export const SERVICE_COLOR: Record<Service, string> = {
  turbopuffer: "var(--chart-1)",
  pinecone: "var(--chart-2)",
  qdrant: "var(--chart-3)",
  opensearch: "var(--chart-4)",
};

export type MetricKey = "avg" | "p50" | "p95" | "max";

export const METRICS: { key: MetricKey; label: string; help: string }[] = [
  { key: "avg", label: "avg", help: "mean latency" },
  { key: "p50", label: "p50", help: "median latency" },
  { key: "p95", label: "p95", help: "95th percentile" },
  { key: "max", label: "max", help: "worst observed" },
];

export const METRIC_COLOR: Record<MetricKey, string> = {
  avg: "var(--chart-1)",
  p50: "var(--chart-2)",
  p95: "var(--chart-3)",
  max: "var(--chart-4)",
};

export const serviceChartConfig: ChartConfig = SERVICES.reduce((acc, s) => {
  acc[s] = { label: SERVICE_LABEL[s], color: SERVICE_COLOR[s] };
  return acc;
}, {} as ChartConfig);

export const metricChartConfig: ChartConfig = METRICS.reduce((acc, m) => {
  acc[m.key] = { label: m.label, color: METRIC_COLOR[m.key] };
  return acc;
}, {} as ChartConfig);

/** Canonical display order + labels for the filter modes. */
const MODE_ORDER: Mode[] = ["unfiltered", "filtered", "filtered-session", "filtered-time"];
export const MODE_LABEL: Record<Mode, string> = {
  unfiltered: "Unfiltered",
  filtered: "Filtered",
  "filtered-session": "Filter: session",
  "filtered-time": "Filter: time",
};

/** Modes actually present in the data, in canonical order (so empty modes never show). */
export function modesIn(rows: EvalRow[]): Mode[] {
  const present = new Set(rows.map((r) => r.mode));
  return MODE_ORDER.filter((m) => present.has(m));
}

/** distinct sorted topK values present in the data */
export function topKsIn(rows: EvalRow[]): number[] {
  return [...new Set(rows.map((r) => r.topK))].sort((a, b) => a - b);
}

export function itersIn(rows: EvalRow[]): number[] {
  return [...new Set(rows.map((r) => r.iters))].sort((a, b) => a - b);
}

/**
 * Pick exactly one row per service for a fixed config. Turbopuffer honors the
 * requested consistency; the other (eventual-only) services ignore it.
 */
export function rowsForConfig(
  rows: EvalRow[],
  opts: { mode: Mode; topK: number; iters: number; tpConsistency: Consistency }
): EvalRow[] {
  const { mode, topK, iters, tpConsistency } = opts;
  return SERVICES.map((service) => {
    const base = rows.filter(
      (r) =>
        r.mode === mode &&
        r.topK === topK &&
        r.iters === iters &&
        r.service === service
    );
    if (service === "turbopuffer") {
      // honor consistency when present; fall back to whatever exists (older
      // evals have no consistency column)
      return base.find((r) => r.consistency === tpConsistency) ?? base[0];
    }
    return base[0];
  }).filter((r): r is EvalRow => Boolean(r));
}

/** Whether this eval distinguishes consistency modes (newer schema). */
export function hasConsistencyData(rows: EvalRow[]): boolean {
  return rows.some((r) => r.consistency !== null);
}

export const fmtMs = (n: number): string =>
  n >= 100 ? n.toFixed(0) : n.toFixed(1);
