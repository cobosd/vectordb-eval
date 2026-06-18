"use client";

import * as React from "react";
import {
  CheckCircle2,
  Loader2,
  PlayCircle,
  Rocket,
  Square,
  Terminal,
  TriangleAlert,
  XCircle,
} from "lucide-react";

import { Nav } from "@/components/Nav";
import { LatencyByServiceChart } from "@/components/LatencyByServiceChart";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toEvalRow } from "@/lib/perf/csv";
import {
  unitKey,
  type RunConfig,
  type RunEvent,
  type RunMode,
  type RunResultRow,
  type RunUnit,
} from "@/lib/perf/types";
import { fmtMs, SERVICE_LABEL, type Service } from "@/lib/eval-helpers";

const SERVICE_OPTIONS: Service[] = ["turbopuffer", "pinecone", "qdrant"];
const TOPK_OPTIONS = [5, 10, 50];
const ITER_OPTIONS = [5, 30, 50];

type UnitState = {
  status: "pending" | "running" | "done" | "error";
  done: number;
  total: number;
  message?: string;
};

type RunPhase = "idle" | "starting" | "running" | "done" | "error";

export function RunClient({ enabled }: { enabled: boolean }) {
  // ---- config form state ----
  const [services, setServices] = React.useState<string[]>([...SERVICE_OPTIONS]);
  const [modes, setModes] = React.useState<string[]>(["unfiltered", "filtered"]);
  const [topKs, setTopKs] = React.useState<string[]>(["10"]);
  const [iters, setIters] = React.useState<string[]>(["30"]);
  const [consistency, setConsistency] = React.useState<string>("eventual");
  const [warm, setWarm] = React.useState(false);
  const [sessions, setSessions] = React.useState("2163");
  const [since, setSince] = React.useState("2026-06-10");
  const [until, setUntil] = React.useState("");
  const [queriesText, setQueriesText] = React.useState("");

  // ---- run state ----
  const [phase, setPhase] = React.useState<RunPhase>("idle");
  const [units, setUnits] = React.useState<RunUnit[]>([]);
  const [unitStates, setUnitStates] = React.useState<Record<string, UnitState>>({});
  const [rows, setRows] = React.useState<RunResultRow[]>([]);
  const [completed, setCompleted] = React.useState(0);
  const [total, setTotal] = React.useState(0);
  const [embedMs, setEmbedMs] = React.useState<number | null>(null);
  const [log, setLog] = React.useState<string[]>([]);
  const [csvFile, setCsvFile] = React.useState<string | null>(null);
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);

  const esRef = React.useRef<EventSource | null>(null);
  const runIdRef = React.useRef<string | null>(null);
  const logBoxRef = React.useRef<HTMLDivElement | null>(null);
  const reconnectRef = React.useRef(0);

  React.useEffect(() => () => esRef.current?.close(), []);
  React.useEffect(() => {
    // Keep the log pinned to its newest line WITHOUT moving the page: scroll the
    // inner log container only (scrollIntoView would scroll the whole window),
    // and only when the user is already near the bottom — so a manual scroll-up
    // to read earlier lines isn't yanked back as steps complete.
    const el = logBoxRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [log]);

  const addLog = (line: string) => setLog((l) => [...l, line]);

  const toggle = (arr: string[], v: string) =>
    arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];

  function applyEvent(ev: RunEvent) {
    switch (ev.type) {
      case "run-start":
        // Reset derived state so a reconnect (which replays the whole buffer)
        // rebuilds cleanly instead of duplicating.
        setUnits(ev.units);
        setTotal(ev.totalUnits);
        setUnitStates(
          Object.fromEntries(
            ev.units.map((u) => [unitKey(u), { status: "pending", done: 0, total: 0 }])
          )
        );
        setRows([]);
        setCompleted(0);
        setEmbedMs(null);
        setCsvFile(null);
        setLog([`Sweep: ${ev.totalUnits} unit(s) — ${ev.config.queries?.length ?? 5} queries`]);
        break;
      case "embed":
        setEmbedMs(ev.ms);
        addLog(`Embedded ${ev.queries} queries in ${ev.ms}ms`);
        break;
      case "unit-start":
        setUnitStates((s) => ({
          ...s,
          [unitKey(ev)]: { ...(s[unitKey(ev)] ?? { done: 0, total: 0 }), status: "running" },
        }));
        addLog(`▶ ${ev.service} · ${ev.mode} · topK=${ev.topK} · iters=${ev.iters}`);
        break;
      case "tick":
        setUnitStates((s) => ({
          ...s,
          [unitKey(ev)]: { status: "running", done: ev.done, total: ev.total },
        }));
        break;
      case "result": {
        const key = unitKey(ev.row);
        setRows((r) => [...r.filter((x) => unitKey(x) !== key), ev.row]);
        setCompleted(ev.completed);
        setUnitStates((s) => ({
          ...s,
          [unitKey(ev.row)]: { status: "done", done: ev.row.iters, total: ev.row.iters },
        }));
        addLog(
          `✓ ${ev.row.service} · ${ev.row.mode} · topK=${ev.row.topK} · iters=${ev.row.iters} → ` +
            `avg ${ev.row.avg_ms} p50 ${ev.row.p50_ms} p95 ${ev.row.p95_ms} max ${ev.row.max_ms} ms`
        );
        break;
      }
      case "unit-error":
        setCompleted(ev.completed);
        setUnitStates((s) => ({
          ...s,
          [unitKey(ev)]: { status: "error", done: 0, total: 0, message: ev.message },
        }));
        addLog(`✗ ${ev.service} · ${ev.mode} · topK=${ev.topK} · iters=${ev.iters}: ${ev.message}`);
        break;
      case "run-done":
        setPhase("done");
        setCsvFile(ev.csvFile);
        addLog(
          `Done — wrote evals/csv/${ev.csvFile} (${ev.rows} rows` +
            `${ev.failed ? `, ${ev.failed} failed` : ""})`
        );
        esRef.current?.close();
        break;
      case "run-error":
        setPhase("error");
        setErrorMsg(ev.message);
        addLog(`ERROR: ${ev.message}`);
        esRef.current?.close();
        break;
      case "log":
        addLog(ev.message);
        break;
    }
  }

  function buildConfig(): { config: RunConfig; error?: string } {
    const sessionIds = sessions
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n));
    const q = queriesText
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    const config: RunConfig = {
      modes: modes as RunMode[],
      topKs: topKs.map(Number),
      iters: iters.map(Number),
      services: services as Service[],
      consistency: consistency as RunConfig["consistency"],
      warm,
      sessions: sessionIds,
      since,
      until: until || undefined,
      ...(q.length ? { queries: q } : {}),
    };
    if (!config.services.length) return { config, error: "Pick at least one service." };
    if (!config.modes.length) return { config, error: "Pick at least one mode." };
    if (!config.topKs.length) return { config, error: "Pick at least one topK." };
    if (!config.iters.length) return { config, error: "Pick at least one iters value." };
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    if (config.modes.includes("filtered")) {
      if (!sessionIds.length) return { config, error: "Filtered mode needs at least one session id." };
      if (!dateRe.test(since)) return { config, error: "'Since' must be a date (YYYY-MM-DD)." };
      if (until && !dateRe.test(until)) return { config, error: "'Until' must be a date (YYYY-MM-DD)." };
    }
    return { config };
  }

  async function start() {
    const { config, error } = buildConfig();
    if (error) {
      setErrorMsg(error);
      return;
    }
    // reset — tear down any prior stream and cancel an abandoned prior run
    esRef.current?.close();
    const prevId = runIdRef.current;
    if (prevId) fetch(`/api/runs/${prevId}`, { method: "DELETE" }).catch(() => {});
    runIdRef.current = null;
    reconnectRef.current = 0;
    setErrorMsg(null);
    setRows([]);
    setUnits([]);
    setUnitStates({});
    setCompleted(0);
    setTotal(0);
    setEmbedMs(null);
    setCsvFile(null);
    setLog([]);
    setPhase("starting");

    try {
      const res = await fetch("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(config),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setPhase("error");
        setErrorMsg(body.error ?? `Failed to start (HTTP ${res.status})`);
        return;
      }
      const { id } = (await res.json()) as { id: string };
      runIdRef.current = id;
      setPhase("running");

      const es = new EventSource(`/api/runs/${id}/stream`);
      esRef.current = es;
      es.onmessage = (e) => {
        reconnectRef.current = 0; // healthy frame → reset the reconnect budget
        try {
          applyEvent(JSON.parse(e.data) as RunEvent);
        } catch {
          /* ignore malformed frame */
        }
      };
      es.onerror = () => {
        // A run-done/run-error handler already closed the stream on completion.
        // Otherwise this is a transient drop: let EventSource auto-reconnect (the
        // server replays the buffered events), giving up only after several tries.
        reconnectRef.current += 1;
        if (reconnectRef.current > 5) {
          setErrorMsg("Lost connection to the run stream.");
          setPhase((p) => (p === "running" || p === "starting" ? "error" : p));
          es.close();
        }
      };
    } catch (e) {
      setPhase("error");
      const msg = e instanceof Error ? e.message : String(e);
      setErrorMsg(
        /fetch/i.test(msg)
          ? "Couldn't reach /api/runs. Make sure the dashboard is being served by the running Next server (bun dev, or bun run build && bun run start) on a host with vector-DB access."
          : msg
      );
    }
  }

  async function cancel() {
    const id = runIdRef.current;
    if (!id) return;
    addLog("Cancelling…");
    await fetch(`/api/runs/${id}`, { method: "DELETE" }).catch(() => {});
  }

  const running = phase === "running" || phase === "starting";

  // latest config group for the live chart
  const latestRows = React.useMemo(() => {
    if (!rows.length) return [];
    const last = rows[rows.length - 1]!;
    return rows
      .filter((r) => r.mode === last.mode && r.topK === last.topK && r.iters === last.iters)
      .map(toEvalRow);
  }, [rows]);
  const latest = rows[rows.length - 1];

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <div className="mb-4 flex items-center gap-2 text-sm text-muted-foreground">
        <Rocket className="h-4 w-4" />
        vectordb-eval
      </div>
      <header className="mb-6 space-y-3">
        <Nav active="run" />
        <h1 className="text-2xl font-semibold tracking-tight">New benchmark run</h1>
      </header>

      {!enabled ? (
        <Card className="border-amber-500/40 bg-amber-500/5">
          <CardContent className="flex gap-3 p-5">
            <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
            <div className="space-y-2 text-sm">
              <p className="font-medium">Runs are disabled in this environment.</p>
              <p className="text-muted-foreground">
                Triggering a benchmark spawns a process that queries the vector
                DBs and writes <code className="rounded bg-muted px-1">evals/csv/</code>,
                which isn&apos;t possible on a read-only/serverless host (e.g. Vercel).
                Run the dashboard on a machine with vector-DB access (locally, or
                your in-region EC2):
              </p>
              <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">
                bun install &amp;&amp; bun run build &amp;&amp; bun run start
                {"\n"}# then open /run on that host
              </pre>
              <p className="text-muted-foreground">
                You can still browse saved results on the{" "}
                <a className="underline" href="/csv">
                  CSV runs
                </a>{" "}
                page.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
          {/* ---- config ---- */}
          <Card className="h-fit">
            <CardHeader>
              <CardTitle>Configuration</CardTitle>
              <CardDescription>
                OpenSearch is excluded (private VPC). Embedding latency is not counted.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Field label="Services">
                <Multi
                  options={SERVICE_OPTIONS.map((s) => ({ value: s, label: SERVICE_LABEL[s] }))}
                  value={services}
                  onChange={setServices}
                  disabled={running}
                />
              </Field>
              <Field label="Mode">
                <Multi
                  options={[
                    { value: "unfiltered", label: "Unfiltered" },
                    { value: "filtered", label: "Filtered" },
                  ]}
                  value={modes}
                  onChange={setModes}
                  disabled={running}
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="topK">
                  <Multi
                    options={TOPK_OPTIONS.map((k) => ({ value: String(k), label: String(k) }))}
                    value={topKs}
                    onChange={setTopKs}
                    disabled={running}
                  />
                </Field>
                <Field label="iters">
                  <Multi
                    options={ITER_OPTIONS.map((k) => ({ value: String(k), label: String(k) }))}
                    value={iters}
                    onChange={setIters}
                    disabled={running}
                  />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Consistency (TP)">
                  <ToggleGroup
                    type="single"
                    variant="outline"
                    size="sm"
                    value={consistency}
                    onValueChange={(v) => v && setConsistency(v)}
                    disabled={running}
                  >
                    <ToggleGroupItem value="eventual" className="px-3">
                      Eventual
                    </ToggleGroupItem>
                    <ToggleGroupItem value="strong" className="px-3">
                      Strong
                    </ToggleGroupItem>
                  </ToggleGroup>
                </Field>
                <Field label="Prewarm">
                  <ToggleGroup
                    type="single"
                    variant="outline"
                    size="sm"
                    value={warm ? "on" : "off"}
                    onValueChange={(v) => v && setWarm(v === "on")}
                    disabled={running}
                  >
                    <ToggleGroupItem value="off" className="px-3">
                      Off
                    </ToggleGroupItem>
                    <ToggleGroupItem value="on" className="px-3">
                      On
                    </ToggleGroupItem>
                  </ToggleGroup>
                </Field>
              </div>

              {modes.includes("filtered") && (
                <div className="space-y-3 rounded-lg border border-dashed p-3">
                  <Field label="Sessions (comma-separated)">
                    <Input value={sessions} onChange={setSessions} disabled={running} />
                  </Field>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Since">
                      <Input value={since} onChange={setSince} placeholder="2026-06-10" disabled={running} />
                    </Field>
                    <Field label="Until (optional)">
                      <Input value={until} onChange={setUntil} placeholder="" disabled={running} />
                    </Field>
                  </div>
                </div>
              )}

              <details className="text-sm">
                <summary className="cursor-pointer text-muted-foreground">
                  Custom queries (optional)
                </summary>
                <textarea
                  className="mt-2 h-24 w-full rounded-md border bg-transparent p-2 text-xs"
                  placeholder="One query per line. Leave empty to use the 5 default queries."
                  value={queriesText}
                  onChange={(e) => setQueriesText(e.target.value)}
                  disabled={running}
                />
              </details>

              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={running}
                  onClick={() => {
                    setTopKs(["5", "10", "50"]);
                    setIters(["5", "50"]);
                    setModes(["unfiltered", "filtered"]);
                  }}
                >
                  Full sweep
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={running}
                  onClick={() => {
                    setTopKs(["10"]);
                    setIters(["5"]);
                  }}
                >
                  Quick
                </Button>
              </div>

              <div className="flex items-center gap-2 pt-1">
                {phase === "running" ? (
                  <Button variant="destructive" className="flex-1" onClick={cancel}>
                    <Square className="h-4 w-4" />
                    Cancel
                  </Button>
                ) : phase === "starting" ? (
                  <Button className="flex-1" disabled>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Starting…
                  </Button>
                ) : (
                  <Button className="flex-1" onClick={start}>
                    <PlayCircle className="h-4 w-4" />
                    Start run
                  </Button>
                )}
              </div>
              {errorMsg && phase !== "running" && (
                <p className="text-sm text-destructive">{errorMsg}</p>
              )}
            </CardContent>
          </Card>

          {/* ---- progress + results ---- */}
          <div className="space-y-6">
            {phase === "idle" ? (
              <Card>
                <CardContent className="p-10 text-center text-sm text-muted-foreground">
                  Configure a sweep and hit <strong>Start run</strong> to watch it
                  live. Results are written to{" "}
                  <code className="rounded bg-muted px-1">evals/csv/</code> and
                  plotted on the{" "}
                  <a className="underline" href="/csv">
                    CSV runs
                  </a>{" "}
                  page.
                </CardContent>
              </Card>
            ) : (
              <>
                <Card>
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between">
                      <CardTitle className="flex items-center gap-2">
                        {phase === "done" ? (
                          <CheckCircle2 className="h-5 w-5 text-chart-2" />
                        ) : phase === "error" ? (
                          <XCircle className="h-5 w-5 text-destructive" />
                        ) : (
                          <Loader2 className="h-5 w-5 animate-spin text-chart-2" />
                        )}
                        {phase === "done"
                          ? "Run complete"
                          : phase === "error"
                            ? "Run failed"
                            : "Running…"}
                      </CardTitle>
                      <span className="text-sm tabular-nums text-muted-foreground">
                        {completed}/{total} units
                        {embedMs != null && ` · embed ${embedMs}ms`}
                      </span>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <Bar value={completed} total={total || 1} />
                    {csvFile && (
                      <p className="text-sm">
                        Saved{" "}
                        <code className="rounded bg-muted px-1">evals/csv/{csvFile}</code>{" "}
                        ·{" "}
                        <a className="underline" href="/csv">
                          view plots
                        </a>
                      </p>
                    )}
                    {errorMsg && <p className="text-sm text-destructive">{errorMsg}</p>}
                    <div className="grid gap-1.5 sm:grid-cols-2">
                      {units.map((u) => {
                        const st = unitStates[unitKey(u)];
                        return <UnitRow key={unitKey(u)} unit={u} state={st} />;
                      })}
                    </div>
                  </CardContent>
                </Card>

                {latestRows.length > 0 && latest && (
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-base">
                        {latest.mode} · topK {latest.topK} · iters {latest.iters}
                      </CardTitle>
                      <CardDescription>latest config (live)</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <LatencyByServiceChart rows={latestRows} metrics={["avg", "p50", "p95"]} />
                    </CardContent>
                  </Card>
                )}

                {rows.length > 0 && (
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-base">Results ({rows.length})</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="rounded-lg border">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Mode</TableHead>
                              <TableHead>topK</TableHead>
                              <TableHead>iters</TableHead>
                              <TableHead>Service</TableHead>
                              <TableHead className="text-right">avg</TableHead>
                              <TableHead className="text-right">p50</TableHead>
                              <TableHead className="text-right">p95</TableHead>
                              <TableHead className="text-right">max</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {rows.map((r, i) => (
                              <TableRow key={i}>
                                <TableCell>
                                  <Badge variant="outline" className="capitalize">
                                    {r.mode}
                                  </Badge>
                                </TableCell>
                                <TableCell className="tabular-nums">{r.topK}</TableCell>
                                <TableCell className="tabular-nums">{r.iters}</TableCell>
                                <TableCell className="font-medium">
                                  {SERVICE_LABEL[r.service] ?? r.service}
                                </TableCell>
                                <TableCell className="text-right font-mono tabular-nums">
                                  {fmtMs(r.avg_ms)}
                                </TableCell>
                                <TableCell className="text-right font-mono tabular-nums">
                                  {fmtMs(r.p50_ms)}
                                </TableCell>
                                <TableCell className="text-right font-mono tabular-nums">
                                  {fmtMs(r.p95_ms)}
                                </TableCell>
                                <TableCell className="text-right font-mono tabular-nums">
                                  {fmtMs(r.max_ms)}
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    </CardContent>
                  </Card>
                )}

                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="flex items-center gap-2 text-base">
                      <Terminal className="h-4 w-4" />
                      Log
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div
                      ref={logBoxRef}
                      className="h-56 overflow-auto rounded-md bg-muted/50 p-3 font-mono text-xs leading-relaxed"
                    >
                      {log.map((line, i) => (
                        <div key={i} className="whitespace-pre-wrap">
                          {line}
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div>{children}</div>
    </div>
  );
}

function Multi({
  options,
  value,
  onChange,
  disabled,
}: {
  options: { value: string; label: string }[];
  value: string[];
  onChange: (v: string[]) => void;
  disabled?: boolean;
}) {
  return (
    <ToggleGroup
      type="multiple"
      variant="outline"
      size="sm"
      value={value}
      onValueChange={(v) => v.length && onChange(v)}
      disabled={disabled}
      className="flex-wrap justify-start"
    >
      {options.map((o) => (
        <ToggleGroupItem key={o.value} value={o.value} className="px-3">
          {o.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

function Input({
  value,
  onChange,
  placeholder,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <input
      className="h-9 w-full rounded-md border bg-transparent px-3 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function Bar({ value, total }: { value: number; total: number }) {
  const pct = total ? Math.min(100, Math.round((value / total) * 100)) : 0;
  return (
    <div className="h-2 w-full overflow-hidden rounded bg-muted">
      <div
        className="h-full bg-chart-2 transition-all"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function UnitRow({ unit, state }: { unit: RunUnit; state?: UnitState }) {
  const status = state?.status ?? "pending";
  const icon =
    status === "done" ? (
      <CheckCircle2 className="h-3.5 w-3.5 text-chart-2" />
    ) : status === "error" ? (
      <XCircle className="h-3.5 w-3.5 text-destructive" />
    ) : status === "running" ? (
      <Loader2 className="h-3.5 w-3.5 animate-spin text-chart-2" />
    ) : (
      <span className="h-3.5 w-3.5 rounded-full border" />
    );
  return (
    <div className="flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs">
      {icon}
      <span className="truncate">
        {SERVICE_LABEL[unit.service] ?? unit.service} · {unit.mode[0]}
        {unit.mode === "filtered" ? "ilt" : "nfilt"} · k{unit.topK} · i{unit.iters}
      </span>
      {status === "running" && state && state.total > 0 && (
        <span className="ml-auto tabular-nums text-muted-foreground">
          {state.done}/{state.total}
        </span>
      )}
    </div>
  );
}
