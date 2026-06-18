/**
 * Latency benchmark orchestrator — a programmatic, streaming version of run.sh.
 *
 * Runs a sweep of (mode × topK × iters × service), measuring end-to-end latency
 * (both collections queried in parallel, the number the eval reports). Emits
 * structured JSONL progress to stdout (one JSON object per line) so a parent
 * process can stream live progress, then writes evals/csv/<timestamp>.csv.
 *
 * Invoked by the dashboard's /api/runs route as:
 *   bun scripts/run-eval.ts '<RunConfig JSON>'
 * but is also runnable standalone (defaults applied for any missing fields).
 *
 * OpenSearch is intentionally excluded from the default service set (private
 * in-VPC domain); the public in-region services are Turbopuffer/Pinecone/Qdrant.
 */

import { COLLECTION_KEYS, type CollectionKey } from "../consts";
import { embedBatch } from "../utils/embedder";
import { createStore } from "../utils/vector-indexer";
import { toEpoch } from "../utils/bill-metadata";
import type {
  QueryFilter,
  ServiceName,
  VectorStore,
} from "../utils/vector-store";
import { logger } from "../logger";

// Keep stdout clean for the JSONL event stream — winston's Console transport
// writes to stdout by default, which would corrupt it. Silence it; we emit our
// own structured events (and the parent also captures stderr).
logger.transports.forEach((t) => (t.silent = true));

type RunMode = "unfiltered" | "filtered";
type Consistency = "strong" | "eventual";

type RunConfig = {
  modes: RunMode[];
  topKs: number[];
  iters: number[];
  services: ServiceName[];
  consistency: Consistency;
  warm: boolean;
  sessions: number[];
  since: string;
  until?: string;
  queries: string[];
};

const DEFAULT_QUERIES = [
  "What bills address renewable energy and solar power incentives?",
  "Regulations on firearm purchases and background checks",
  "Funding for public education and teacher salaries",
  "Healthcare access and Medicaid expansion",
  "Criminal justice reform and sentencing guidelines",
];

// Single source of truth for the CSV column order (mirrored in src/lib/perf/csv.ts).
const CSV_COLUMNS = [
  "run_at",
  "mode",
  "topK",
  "iters",
  "service",
  "consistency",
  "avg_ms",
  "p50_ms",
  "p95_ms",
  "max_ms",
  "min_ms",
  "calls",
  "queries",
  "sessions",
  "since",
  "until",
  "warm",
] as const;

function emit(event: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(event) + "\n");
}

const round = (n: number) => Math.round(n * 10) / 10;

function stats(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const pct = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    calls: sorted.length,
    min: round(sorted[0] ?? 0),
    avg: round(sum / (sorted.length || 1)),
    p50: round(pct(50)),
    p95: round(pct(95)),
    max: round(sorted[sorted.length - 1] ?? 0),
  };
}

async function timeIt(fn: () => Promise<unknown>): Promise<number> {
  const start = performance.now();
  await fn();
  return performance.now() - start;
}

function parseConfig(): RunConfig {
  let c: Partial<RunConfig> = {};
  const raw = process.argv[2];
  if (raw) {
    try {
      c = JSON.parse(raw);
    } catch {
      emit({ type: "run-error", message: "invalid RunConfig JSON argument" });
      process.exit(1);
    }
  }
  const posInts = (a: unknown, fallback: number[]): number[] => {
    const v = Array.isArray(a)
      ? [...new Set(a.map(Number).filter((n) => Number.isInteger(n) && n > 0))]
      : [];
    return v.length ? v : fallback;
  };
  const finiteNums = (a: unknown, fallback: number[]): number[] => {
    const v = Array.isArray(a) ? a.map(Number).filter((n) => Number.isFinite(n)) : [];
    return v.length ? v : fallback;
  };
  return {
    modes: c.modes?.length ? c.modes : ["unfiltered", "filtered"],
    topKs: posInts(c.topKs, [10]),
    iters: posInts(c.iters, [30]),
    services: c.services?.length ? c.services : ["turbopuffer", "pinecone", "qdrant"],
    consistency: c.consistency === "strong" ? "strong" : "eventual",
    warm: !!c.warm,
    sessions: finiteNums(c.sessions, [2163]),
    since: c.since ?? "2026-06-10",
    until: c.until || undefined,
    queries: c.queries?.length ? c.queries : DEFAULT_QUERIES,
  };
}

function buildFilter(cfg: RunConfig): QueryFilter {
  const sinceEpoch = toEpoch(cfg.since);
  const untilEpoch = cfg.until ? toEpoch(cfg.until) : 0;
  return [
    cfg.sessions.length === 1
      ? { field: "session_id", op: "eq", value: cfg.sessions[0]! }
      : { field: "session_id", op: "in", value: cfg.sessions },
    { field: "notification_action_time_epoch", op: "gte", value: sinceEpoch },
    ...(untilEpoch
      ? [
          {
            field: "notification_action_time_epoch",
            op: "lte" as const,
            value: untilEpoch,
          },
        ]
      : []),
  ];
}

function csvEscape(v: unknown): string {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

async function main() {
  const cfg = parseConfig();
  const started = new Date();
  const runAt = started.toISOString();
  const filter = buildFilter(cfg);

  const units: { mode: RunMode; topK: number; iters: number; service: ServiceName }[] = [];
  for (const mode of cfg.modes)
    for (const topK of cfg.topKs)
      for (const iters of cfg.iters)
        for (const service of cfg.services) units.push({ mode, topK, iters, service });

  emit({ type: "run-start", runAt, config: cfg, units, totalUnits: units.length });

  // Embed the query set once; vectors are reused across every config (embedding
  // latency is excluded from the measurement anyway).
  const t0 = performance.now();
  let vectors: number[][];
  try {
    vectors = await embedBatch(cfg.queries);
  } catch (e) {
    emit({
      type: "run-error",
      message: `embedding failed: ${e instanceof Error ? e.message : String(e)}`,
    });
    process.exit(1);
  }
  emit({ type: "embed", ms: round(performance.now() - t0), queries: cfg.queries.length });

  type CsvRow = Record<(typeof CSV_COLUMNS)[number], string | number | boolean>;
  const rows: CsvRow[] = [];
  let completed = 0;
  let failed = 0;

  for (const mode of cfg.modes) {
    for (const topK of cfg.topKs) {
      for (const iters of cfg.iters) {
        for (const service of cfg.services) {
          emit({ type: "unit-start", mode, topK, iters, service });
          try {
            const stores = Object.fromEntries(
              COLLECTION_KEYS.map((c) => [c, createStore(service, c)])
            ) as Record<CollectionKey, VectorStore>;
            const opts = {
              topK,
              consistency: cfg.consistency,
              ...(mode === "filtered" ? { filter } : {}),
            };

            if (cfg.warm) {
              await Promise.all(
                COLLECTION_KEYS.map((c) => stores[c].warm?.().catch(() => {}))
              );
            }
            // Prime the HTTP connection with a throwaway (unmeasured) query.
            await Promise.all(
              COLLECTION_KEYS.map((c) => stores[c].query(vectors[0]!, opts).catch(() => []))
            );

            const samples: number[] = [];
            for (let i = 0; i < iters; i++) {
              for (const vector of vectors) {
                const ms = await timeIt(() =>
                  Promise.all(COLLECTION_KEYS.map((c) => stores[c].query(vector, opts)))
                );
                samples.push(ms);
              }
              emit({ type: "tick", mode, topK, iters, service, done: i + 1, total: iters });
            }

            if (!samples.length) throw new Error("no latency samples collected");
            const s = stats(samples);
            const row: CsvRow = {
              run_at: runAt,
              mode,
              topK,
              iters,
              service,
              consistency: cfg.consistency,
              avg_ms: s.avg,
              p50_ms: s.p50,
              p95_ms: s.p95,
              max_ms: s.max,
              min_ms: s.min,
              calls: s.calls,
              queries: cfg.queries.length,
              sessions: mode === "filtered" ? cfg.sessions.join(" ") : "",
              since: mode === "filtered" ? cfg.since : "",
              until: mode === "filtered" ? cfg.until ?? "" : "",
              warm: cfg.warm,
            };
            rows.push(row);
            completed++;
            emit({ type: "result", row, completed, totalUnits: units.length });
          } catch (e) {
            completed++;
            failed++;
            emit({
              type: "unit-error",
              mode,
              topK,
              iters,
              service,
              message: e instanceof Error ? e.message : String(e),
              completed,
              totalUnits: units.length,
            });
          }
        }
      }
    }
  }

  // If every unit failed, don't write an empty CSV — surface an error instead.
  if (rows.length === 0) {
    emit({
      type: "run-error",
      message: `all ${units.length} unit(s) failed — no CSV written`,
    });
    process.exit(1);
  }

  // Persist CSV to evals/csv/<YYYY-MM-DD_HHMMSS>.csv (local-time stamp matches
  // the existing eval markdown naming).
  const stamp =
    `${started.getFullYear()}-${pad(started.getMonth() + 1)}-${pad(started.getDate())}` +
    `_${pad(started.getHours())}${pad(started.getMinutes())}${pad(started.getSeconds())}`;
  const file = `${stamp}.csv`;
  const dir = `${process.cwd()}/evals/csv`;
  const path = `${dir}/${file}`;
  const header = CSV_COLUMNS.join(",");
  const body = rows
    .map((r) => CSV_COLUMNS.map((col) => csvEscape(r[col])).join(","))
    .join("\n");
  await Bun.write(path, `${header}\n${body}\n`);

  emit({ type: "run-done", csvFile: file, csvPath: path, rows: rows.length, failed });
  // Sockets (OpenAI/undici keep-alive) can keep the loop alive; exit explicitly
  // so the parent sees EOF promptly.
  process.exit(0);
}

main().catch((e) => {
  emit({ type: "run-error", message: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
