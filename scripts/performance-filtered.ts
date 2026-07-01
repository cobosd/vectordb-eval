/**
 * Filtered variant of scripts/performance.ts: same latency comparison, but every
 * query carries a metadata pre-filter on session_id (eq for one session, `in` for
 * several) and notification_action_time_epoch (numeric range — a lower bound, and
 * optionally an upper bound for a bounded `since <= date <= until` window). Both
 * filters are numeric, so Turbopuffer and Pinecone run the identical filter for a
 * fair comparison.
 *
 * Requires the epoch field to exist — it's written natively by the ingester
 * (buildBillMetadata), so any normal ingest produces it.
 *
 *   bun scripts/performance-filtered.ts
 *   bun scripts/performance-filtered.ts --session=2163 --since=2026-06-10 --topk=20 --iterations=50
 *   # multiple sessions (session_id IN [...]) + a bounded date window (since <= date <= until):
 *   bun scripts/performance-filtered.ts --sessions=2176,2244,2189 --since=2026-05-15 --until=2026-06-10
 *   # exercise one predicate at a time (--filter=session|time|both, default both):
 *   bun scripts/performance-filtered.ts --filter=session
 *   bun scripts/performance-filtered.ts --filter=time --since=2026-06-10
 *   # return ids only (no metadata) to isolate search latency from payload cost:
 *   bun scripts/performance-filtered.ts --minimal --filter=time
 */

import { COLLECTION_KEYS, COLLECTIONS, type CollectionKey } from "../consts";
import { embedBatch } from "../utils/embedder";
import { createStore } from "../utils/vector-indexer";
import { toEpoch } from "../utils/bill-metadata";
import type { QueryFilter, QueryPerf, ServiceName, VectorStore } from "../utils/vector-store";
import { aggregatePerf, appendPerfRows, type PerfCsvRow } from "../utils/perf-csv";
import { createLogger } from "../logger";

const logger = createLogger("performance-filtered");

const DEFAULT_QUERIES = [
  "What bills address renewable energy and solar power incentives?",
  "Regulations on firearm purchases and background checks",
  "Funding for public education and teacher salaries",
  "Healthcare access and Medicaid expansion",
  "Criminal justice reform and sentencing guidelines",
];

const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const found = args.find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};

const KNOWN_FLAGS = new Set(["topk", "iterations", "services", "consistency", "filter", "session", "sessions", "since", "until", "warm", "minimal", "collections"]);
const unknown = args
  .filter((a) => a.startsWith("--"))
  .map((a) => a.slice(2).split("=")[0]!)
  .filter((name) => !KNOWN_FLAGS.has(name));
if (unknown.length) {
  console.error(`Unknown flag(s): ${unknown.map((u) => `--${u}`).join(", ")}. Known: ${[...KNOWN_FLAGS].map((k) => `--${k}`).join(", ")}`);
  process.exit(1);
}

const QUERIES = args.filter((a) => !a.startsWith("--"));
const queries = QUERIES.length ? QUERIES : DEFAULT_QUERIES;
const TOPK = Number(flag("topk", "20"));
const ITERATIONS = Number(flag("iterations", "50"));
const SERVICES = flag("services", "turbopuffer,pinecone").split(",").filter(Boolean) as ServiceName[];
const CONSISTENCY = flag("consistency", "strong") as "strong" | "eventual";
// Which predicate to exercise: session_id only, notification_action_time only, or
// both ANDed (the original combined filter). Splitting them isolates how each
// predicate's selectivity drives latency — a session id is highly selective, a
// since-date typically matches far more rows.
const FILTER_KIND = flag("filter", "both") as "session" | "time" | "both";
if (!["session", "time", "both"].includes(FILTER_KIND)) {
  console.error(`Invalid --filter: "${FILTER_KIND}". Expected one of: session, time, both.`);
  process.exit(1);
}
// Native cache prewarm (Turbopuffer) is off by default; --warm enables it.
const WARM = args.includes("--warm");
// --minimal: return only document ids (no metadata) to isolate search latency
// from response-payload cost.
const MINIMAL = args.includes("--minimal");

// --sessions=2176,2244 (preferred) or --session=2176 (single, back-compat).
const SESSIONS = flag("sessions", flag("session", "2163"))
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n));
if (SESSIONS.length === 0) {
  console.error(`No valid session ids in --sessions (got "${flag("sessions", flag("session", ""))}").`);
  process.exit(1);
}

const SINCE = flag("since", "2026-06-10");
const UNTIL = flag("until", ""); // optional upper bound; empty = open-ended (since-only)

// --collections=bill (or a CSV) restricts the sweep to specific collections.
// Defaults to the two-namespace set (bill_text, bill_amendment).
const COLLECTIONS_TO_RUN: CollectionKey[] = (() => {
  const raw = flag("collections", "");
  if (!raw) return COLLECTION_KEYS;
  const requested = raw.split(",").map((c) => c.trim()).filter(Boolean);
  const bad = requested.filter((c) => !(c in COLLECTIONS));
  if (bad.length) {
    console.error(`Unknown collection(s): ${bad.join(", ")}. Known: ${Object.keys(COLLECTIONS).join(", ")}`);
    process.exit(1);
  }
  return requested as CollectionKey[];
})();

const SINCE_EPOCH = toEpoch(SINCE);
if (SINCE_EPOCH === 0) {
  console.error(`Invalid --since date: "${SINCE}" (expected an ISO date like 2026-06-10).`);
  process.exit(1);
}
const UNTIL_EPOCH = UNTIL ? toEpoch(UNTIL) : 0;
if (UNTIL && UNTIL_EPOCH === 0) {
  console.error(`Invalid --until date: "${UNTIL}" (expected an ISO date like 2026-06-10).`);
  process.exit(1);
}
if (UNTIL_EPOCH && UNTIL_EPOCH <= SINCE_EPOCH) {
  console.error(`--until (${UNTIL}) must be after --since (${SINCE}).`);
  process.exit(1);
}
// RFC3339 form of the same bounds, for collections that store the date as a native
// Turbopuffer `datetime` rather than a numeric epoch (see TIME field selection below).
const SINCE_ISO = new Date(SINCE_EPOCH).toISOString();
const UNTIL_ISO = UNTIL_EPOCH ? new Date(UNTIL_EPOCH).toISOString() : "";

// The single-namespace `bill` collection carries the date as a native `datetime`
// attribute (`notification_action_time`) and has NO `..._epoch` column, so it must
// be range-filtered with RFC3339 strings. The two-namespace collections carry the
// numeric epoch. Both express the same window; only the field + value type differ.
const DATETIME_COLLECTIONS = new Set<CollectionKey>(["bill"]);

const SESSION_CLAUSE: QueryFilter[number] =
  SESSIONS.length === 1
    ? { field: "session_id", op: "eq", value: SESSIONS[0]! }
    : { field: "session_id", op: "in", value: SESSIONS };

function timeClausesFor(collection: CollectionKey): QueryFilter {
  if (DATETIME_COLLECTIONS.has(collection)) {
    return [
      { field: "notification_action_time", op: "gte", value: SINCE_ISO },
      ...(UNTIL_ISO ? [{ field: "notification_action_time", op: "lte", value: UNTIL_ISO } satisfies QueryFilter[number]] : []),
    ];
  }
  return [
    { field: "notification_action_time_epoch", op: "gte", value: SINCE_EPOCH },
    ...(UNTIL_EPOCH ? [{ field: "notification_action_time_epoch", op: "lte", value: UNTIL_EPOCH } satisfies QueryFilter[number]] : []),
  ];
}

// Per-collection filter (both backends run the identical clause for a given
// collection). --filter picks which predicates apply:
//   session → session_id eq/in only
//   time    → notification_action_time range only (lower bound, +upper if --until)
//   both    → both, ANDed
function filterFor(collection: CollectionKey): QueryFilter {
  const time = timeClausesFor(collection);
  return FILTER_KIND === "session"
    ? [SESSION_CLAUSE]
    : FILTER_KIND === "time"
      ? time
      : [SESSION_CLAUSE, ...time];
}

// CSV identity + provenance for this filter kind. `both` keeps the legacy
// "filtered" mode; the split kinds get their own mode so dashboard rows don't
// collide on (mode, topK, iters, service, consistency). Each records only the
// metadata it actually filtered on.
const CSV_MODE = FILTER_KIND === "both" ? "filtered" : `filtered-${FILTER_KIND}`;
const CSV_SESSIONS = FILTER_KIND === "time" ? "" : SESSIONS.join(" ");
const CSV_SINCE = FILTER_KIND === "session" ? "" : SINCE;
const CSV_UNTIL = FILTER_KIND === "session" ? "" : UNTIL;

const round = (n: number) => Math.round(n * 10) / 10;

async function timeIt<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const start = performance.now();
  const result = await fn();
  return [result, performance.now() - start];
}

// Surface a hanging call instead of stalling the benchmark indefinitely.
const QUERY_TIMEOUT_MS = 20_000;
function withTimeout<T>(label: string, promise: Promise<T>, ms = QUERY_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function stats(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    calls: sorted.length,
    "min(ms)": round(sorted[0] ?? 0),
    "avg(ms)": round(sum / (sorted.length || 1)),
    "p50(ms)": round(pct(50)),
    "p95(ms)": round(pct(95)),
    "max(ms)": round(sorted[sorted.length - 1] ?? 0),
  };
}

type StatsRow = ReturnType<typeof stats>;

const HIGHLIGHT = "\x1b[30;102m";
const RESET = "\x1b[0m";

function color(value: string | number): string {
  return `${HIGHLIGHT}${value}${RESET}`;
}

function sortedTable<T>(rows: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(rows).sort(([a], [b]) => a.localeCompare(b))) as Record<string, T>;
}

function winnerKeys(rows: Record<string, StatsRow>, group: (key: string) => string): Set<string> {
  const best = new Map<string, { key: string; avg: number }>();
  for (const [key, row] of Object.entries(rows)) {
    const groupKey = group(key);
    const avg = row["avg(ms)"];
    const current = best.get(groupKey);
    if (!current || avg < current.avg || (avg === current.avg && key.localeCompare(current.key) < 0)) {
      best.set(groupKey, { key, avg });
    }
  }
  return new Set([...best.values()].map((v) => v.key));
}

function highlightedStatsTable(rows: Record<string, StatsRow>, winners: Set<string>): Record<string, StatsRow | Record<string, string>> {
  return Object.fromEntries(
    Object.entries(rows)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, row]) => {
        if (!winners.has(key)) return [key, row];
        return [
          color(key),
          Object.fromEntries(Object.entries(row).map(([field, value]) => [field, color(value)])),
        ];
      }),
  );
}

async function main() {
  logger.info("Embedding queries", {
    queries: queries.length,
    services: SERVICES,
    topK: TOPK,
    consistency: CONSISTENCY,
    filterKind: FILTER_KIND,
    filter: { sessions: SESSIONS, since: SINCE, until: UNTIL || undefined },
  });
  const [vectors, embedMs] = await timeIt(() => embedBatch(queries));
  const sessionClause =
    SESSIONS.length === 1 ? `session_id == ${SESSIONS[0]}` : `session_id IN [${SESSIONS.join(", ")}]`;
  // Date field/value type varies by collection (epoch vs datetime); show the window
  // by human date and note the collections that use the native datetime attribute.
  const dateClause = UNTIL
    ? `${SINCE} <= notification_action_time <= ${UNTIL}`
    : `notification_action_time >= ${SINCE}`;
  const filterDesc =
    FILTER_KIND === "session" ? sessionClause
    : FILTER_KIND === "time" ? dateClause
    : `${sessionClause} AND ${dateClause}`;
  const dtNote = COLLECTIONS_TO_RUN.some((c) => DATETIME_COLLECTIONS.has(c))
    ? ` (datetime filter for: ${COLLECTIONS_TO_RUN.filter((c) => DATETIME_COLLECTIONS.has(c)).join(", ")})`
    : "";
  console.log(
    `\nEmbedded ${queries.length} queries in ${round(embedMs)}ms. ` +
      `Collections: ${COLLECTIONS_TO_RUN.join(", ")}. ` +
      `Filter [${FILTER_KIND}]${MINIMAL ? " (minimal: id-only)" : ""}: ${filterDesc}${dtNote}\n`,
  );

  const perCall: Record<string, number[]> = {};
  const endToEnd: Record<string, number[]> = {};
  const endToEndMax: Record<string, number[]> = {};
  const hitCounts: Record<string, number> = {};
  // service -> server-side diagnostics from the measured per-collection calls.
  const perfByService: Record<string, QueryPerf[]> = {};

  // Base opts shared by every call; the metadata filter is added per-collection
  // (the date predicate's field/value type differs between collections).
  const baseOpts = { topK: TOPK, consistency: CONSISTENCY, minimal: MINIMAL };
  const optsFor = (collection: CollectionKey) => ({ ...baseOpts, filter: filterFor(collection) });

  await Promise.all(SERVICES.map(async (service) => {
    const stores = Object.fromEntries(
      COLLECTIONS_TO_RUN.map((c) => [c, createStore(service, c)]),
    ) as Record<CollectionKey, VectorStore>;
    const onPerf = (p: QueryPerf) => (perfByService[service] ??= []).push(p);

    // Native cache prewarm (Turbopuffer) only when --warm is passed; off by default.
    if (WARM) await Promise.all(COLLECTIONS_TO_RUN.map((c) => stores[c].warm?.().catch(() => {})));
    await Promise.all(
      COLLECTIONS_TO_RUN.map((c) =>
        withTimeout(`${service}:${c} warmup`, stores[c].query(vectors[0]!, optsFor(c)))
          .then((hits) => (hitCounts[`${service}:${c}`] = hits.length))
          .catch(() => []),
      ),
    );

    for (let iter = 0; iter < ITERATIONS; iter++) {
      for (const vector of vectors) {
        for (const collection of COLLECTIONS_TO_RUN) {
          const label = `${service}:${collection}`;
          const [, ms] = await timeIt(() => withTimeout(label, stores[collection].query(vector, { ...optsFor(collection), onPerf })));
          (perCall[`${service}:${collection}`] ??= []).push(ms);
        }
        const components: number[] = [];
        const [, combined] = await timeIt(() =>
          Promise.all(
            COLLECTIONS_TO_RUN.map(async (collection) => {
              const label = `${service}:${collection} parallel`;
              const [, ms] = await timeIt(() => withTimeout(label, stores[collection].query(vector, optsFor(collection))));
              components.push(ms);
            }),
          ),
        );
        (endToEnd[service] ??= []).push(combined);
        (endToEndMax[service] ??= []).push(Math.max(...components));
      }
    }
  }));

  console.log("Hits matching the filter (first query, topK):");
  console.table(sortedTable(hitCounts));

  console.log("\nPer-collection filtered query latency:");
  const perCollectionRows = Object.fromEntries(Object.entries(perCall).map(([k, v]) => [k, stats(v)]));
  console.table(highlightedStatsTable(perCollectionRows, winnerKeys(perCollectionRows, (key) => key.split(":")[1] ?? key)));

  console.log("\nEnd-to-end filtered search latency (both collections in parallel):");
  const e2eRows: Record<string, ReturnType<typeof stats>> = {};
  for (const service of SERVICES) {
    if (endToEnd[service]) e2eRows[`${service} end-to-end`] = stats(endToEnd[service]!);
    if (endToEndMax[service]) e2eRows[`${service} max(per-collection)`] = stats(endToEndMax[service]!);
  }
  console.table(highlightedStatsTable(e2eRows, winnerKeys(e2eRows, (key) => key.includes("max(per-collection)") ? "max" : "end-to-end")));

  // Persist the per-service end-to-end stats to CSV when a caller (run.sh) sets
  // PERF_CSV. Filtered rows carry the session/date window so the dashboard can
  // distinguish them from the unfiltered rows in the same file.
  await writeCsv(endToEnd, perfByService);
}

async function writeCsv(
  endToEnd: Record<string, number[]>,
  perfByService: Record<string, QueryPerf[]>,
): Promise<void> {
  const path = process.env.PERF_CSV;
  if (!path) return;
  const runAt = process.env.PERF_RUN_AT || new Date().toISOString();
  const rows: PerfCsvRow[] = SERVICES.filter((s) => endToEnd[s]?.length).map((service) => {
    const s = stats(endToEnd[service]!);
    return {
      run_at: runAt,
      mode: CSV_MODE,
      topK: TOPK,
      iters: ITERATIONS,
      service,
      consistency: CONSISTENCY,
      avg_ms: s["avg(ms)"],
      p50_ms: s["p50(ms)"],
      p95_ms: s["p95(ms)"],
      max_ms: s["max(ms)"],
      min_ms: s["min(ms)"],
      calls: s.calls,
      queries: queries.length,
      sessions: CSV_SESSIONS,
      since: CSV_SINCE,
      until: CSV_UNTIL,
      warm: WARM,
      ...aggregatePerf(perfByService[service] ?? []),
    };
  });
  await appendPerfRows(path, rows);
  console.log(`\n→ appended ${rows.length} ${CSV_MODE} row(s) to ${path}`);
}

main().catch((error) => {
  logger.error("Filtered performance run failed", {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exit(1);
});
