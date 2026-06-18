"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Activity, Database, Gauge, Info, Trash2 } from "lucide-react";

import type { EvalDoc } from "@/lib/eval-data";
import { Nav } from "@/components/Nav";
import { ConsistencyChart } from "@/components/ConsistencyChart";
import { EvalDataTable } from "@/components/EvalDataTable";
import { LatencyByServiceChart } from "@/components/LatencyByServiceChart";
import { Markdown } from "@/components/Markdown";
import { ScalingChart } from "@/components/ScalingChart";
import { StatCards } from "@/components/StatCards";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  hasConsistencyData,
  itersIn,
  METRICS,
  rowsForConfig,
  topKsIn,
  type Consistency,
  type MetricKey,
  type Mode,
} from "@/lib/eval-helpers";

export function DashboardClient({
  docs,
  active = "dashboard",
  pickerLabel = "Eval run",
  deletable = false,
}: {
  docs: EvalDoc[];
  active?: string;
  pickerLabel?: string;
  /** Show a per-run delete button (CSV runs only, self-hosted). */
  deletable?: boolean;
}) {
  const router = useRouter();
  const [file, setFile] = React.useState<string>(docs[0]?.file ?? "");
  const [deleting, setDeleting] = React.useState(false);
  const doc = docs.find((d) => d.file === file) ?? docs[0];

  async function deleteCurrent() {
    if (!doc) return;
    if (!window.confirm(`Delete ${doc.file}? This removes evals/csv/${doc.file}.`)) {
      return;
    }
    setDeleting(true);
    try {
      const res = await fetch(`/api/csv/${encodeURIComponent(doc.file)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        window.alert(body.error ?? `Delete failed (HTTP ${res.status})`);
        return;
      }
      setFile(""); // fall back to the first remaining run
      router.refresh(); // re-read evals/csv on the server
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <div className="mb-4 flex items-center gap-2 text-sm text-muted-foreground">
        <Database className="h-4 w-4" />
        vectordb-eval
      </div>
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-3">
          <Nav active={active} />
          <h1 className="text-2xl font-semibold tracking-tight">
            {doc?.title ?? "Latency dashboard"}
          </h1>
        </div>
        {docs.length > 0 && (
          <div className="flex flex-col items-end gap-1">
            <span className="text-xs text-muted-foreground">{pickerLabel}</span>
            <div className="flex items-center gap-2">
              <Select value={file} onValueChange={setFile}>
                <SelectTrigger className="w-[260px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {docs.map((d) => (
                    <SelectItem key={d.file} value={d.file}>
                      {d.file}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {deletable && doc && (
                <Button
                  variant="outline"
                  size="icon"
                  onClick={deleteCurrent}
                  disabled={deleting}
                  title={`Delete ${doc.file}`}
                  className="shrink-0 text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </div>
          </div>
        )}
      </header>

      {!doc ? (
        <div className="py-24 text-center text-muted-foreground">
          No eval files found.
        </div>
      ) : (
        <Dashboard key={doc.file} doc={doc} />
      )}
    </div>
  );
}

function Dashboard({ doc }: { doc: EvalDoc }) {
  const { rows } = doc;
  const topKs = React.useMemo(() => topKsIn(rows), [rows]);
  const iterList = React.useMemo(() => itersIn(rows), [rows]);
  const showConsistency = React.useMemo(() => hasConsistencyData(rows), [rows]);

  const [mode, setMode] = React.useState<Mode>("filtered");
  const [topK, setTopK] = React.useState<number>(topKs[0] ?? 5);
  const [iters, setIters] = React.useState<number>(
    iterList[iterList.length - 1] ?? 50
  );
  const [tpConsistency, setTpConsistency] =
    React.useState<Consistency>("eventual");
  const [metrics, setMetrics] = React.useState<MetricKey[]>([
    "avg",
    "p50",
    "p95",
  ]);
  const [scalingMetric, setScalingMetric] = React.useState<MetricKey>("p50");

  // keep selections valid if the dataset changes
  React.useEffect(() => {
    if (!topKs.includes(topK)) setTopK(topKs[0] ?? 5);
    if (!iterList.includes(iters)) setIters(iterList[iterList.length - 1] ?? 50);
  }, [topKs, iterList]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedRows = React.useMemo(
    () => rowsForConfig(rows, { mode, topK, iters, tpConsistency }),
    [rows, mode, topK, iters, tpConsistency]
  );

  return (
    <div className="space-y-6">
      {doc.intro && (
        <Card className="border-chart-3/40 bg-chart-3/5">
          <CardContent className="flex gap-3 p-4">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-chart-3" />
            <Markdown className="[&_p:first-child]:mt-0 [&_p:last-child]:mb-0">
              {doc.intro}
            </Markdown>
          </CardContent>
        </Card>
      )}

      <StatCards rows={rows} />

      <Tabs defaultValue="compare">
        <TabsList>
          <TabsTrigger value="compare">
            <Gauge className="mr-1.5 h-4 w-4" />
            Compare
          </TabsTrigger>
          {showConsistency && (
            <TabsTrigger value="consistency">
              <Activity className="mr-1.5 h-4 w-4" />
              Consistency
            </TabsTrigger>
          )}
          <TabsTrigger value="data">Data table</TabsTrigger>
        </TabsList>

        {/* ---- Compare ---- */}
        <TabsContent value="compare" className="space-y-4">
          <Card>
            <CardContent className="flex flex-wrap items-end gap-x-6 gap-y-3 p-4">
              <Control label="Mode">
                <SingleToggle
                  value={mode}
                  onChange={(v) => setMode(v as Mode)}
                  options={[
                    { value: "unfiltered", label: "Unfiltered" },
                    { value: "filtered", label: "Filtered" },
                  ]}
                />
              </Control>
              <Control label="topK">
                <SingleToggle
                  value={String(topK)}
                  onChange={(v) => setTopK(Number(v))}
                  options={topKs.map((k) => ({
                    value: String(k),
                    label: String(k),
                  }))}
                />
              </Control>
              <Control label="iters">
                <SingleToggle
                  value={String(iters)}
                  onChange={(v) => setIters(Number(v))}
                  options={iterList.map((i) => ({
                    value: String(i),
                    label: String(i),
                  }))}
                />
              </Control>
              {showConsistency && (
                <Control label="Turbopuffer consistency">
                  <SingleToggle
                    value={tpConsistency ?? "eventual"}
                    onChange={(v) => setTpConsistency(v as Consistency)}
                    options={[
                      { value: "eventual", label: "Eventual" },
                      { value: "strong", label: "Strong" },
                    ]}
                  />
                </Control>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <div>
                <CardTitle>Latency by service</CardTitle>
                <CardDescription>
                  {mode} · topK {topK} · {iters} iters
                  {showConsistency && ` · Turbopuffer ${tpConsistency}`}
                </CardDescription>
              </div>
              <MultiMetricToggle value={metrics} onChange={setMetrics} />
            </CardHeader>
            <CardContent>
              <LatencyByServiceChart rows={selectedRows} metrics={metrics} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <div>
                <CardTitle>Scaling with topK</CardTitle>
                <CardDescription>
                  {scalingMetric} latency vs topK · {mode} · {iters} iters
                  {showConsistency && ` · Turbopuffer ${tpConsistency}`}
                </CardDescription>
              </div>
              <SingleToggle
                value={scalingMetric}
                onChange={(v) => setScalingMetric(v as MetricKey)}
                options={METRICS.map((m) => ({
                  value: m.key,
                  label: m.label,
                }))}
              />
            </CardHeader>
            <CardContent>
              <ScalingChart
                rows={rows}
                mode={mode}
                iters={iters}
                tpConsistency={tpConsistency}
                metric={scalingMetric}
              />
            </CardContent>
          </Card>
        </TabsContent>

        {/* ---- Consistency ---- */}
        {showConsistency && (
          <TabsContent value="consistency" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Consistency tax — Turbopuffer</CardTitle>
                <CardDescription>
                  p50 latency, eventual vs strong, across every config. Strong
                  adds an object-storage round-trip; the other engines are
                  eventual-only.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ConsistencyChart rows={rows} metric="p50" />
              </CardContent>
            </Card>
          </TabsContent>
        )}

        {/* ---- Data table ---- */}
        <TabsContent value="data">
          <Card>
            <CardHeader>
              <CardTitle>All measurements</CardTitle>
              <CardDescription>
                {rows.length} rows · end-to-end latency in ms · sort columns and
                filter by service, mode, or consistency.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <EvalDataTable rows={rows} />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {doc.notes && (
        <Card>
          <CardHeader>
            <CardTitle>Observations</CardTitle>
          </CardHeader>
          <CardContent>
            <Markdown>{doc.notes}</Markdown>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Control({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function SingleToggle({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      value={value}
      onValueChange={(v) => v && onChange(v)}
    >
      {options.map((o) => (
        <ToggleGroupItem key={o.value} value={o.value} className="px-3">
          {o.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

function MultiMetricToggle({
  value,
  onChange,
}: {
  value: MetricKey[];
  onChange: (v: MetricKey[]) => void;
}) {
  return (
    <ToggleGroup
      type="multiple"
      variant="outline"
      size="sm"
      value={value}
      onValueChange={(v) => v.length && onChange(v as MetricKey[])}
    >
      {METRICS.map((m) => (
        <ToggleGroupItem key={m.key} value={m.key} className="px-3">
          {m.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
