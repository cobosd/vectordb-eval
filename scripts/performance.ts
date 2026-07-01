/**
 * Compare query performance between vector-db backends (Turbopuffer vs Pinecone)
 * on the same set of questions.
 *
 * For each question: embed once (shared across services, so embedding latency
 * isn't double-counted), then time (a) each per-collection query in isolation
 * and (b) the end-to-end "search both collections in parallel" path. Prints
 * latency stats (min/avg/p50/p95/max). Queries return all metadata but no vector.
 *
 *   bun scripts/performance.ts
 *   bun scripts/performance.ts --services=turbopuffer,pinecone --topk=10 --iterations=5
 *   bun scripts/performance.ts "renewable energy incentives" "background check rules"
 *   bun scripts/performance.ts --query="school funding"   # run one query once per service
 *   bun scripts/performance.ts --warm                     # opt into native cache prewarm
 *   bun scripts/performance.ts --attribute-payload=minimal  # ids only (no metadata payload)
 *   bun scripts/performance.ts --attribute-payload=decent   # ids + content + date only
 *   bun scripts/performance.ts --attribute-payload=full     # all attributes (default)
 */

import { COLLECTION_KEYS, COLLECTIONS, type CollectionKey } from "../consts";
import { embedBatch } from "../utils/embedder";
import { createStore } from "../utils/vector-indexer";
import type { AttributePayload, QueryPerf, ServiceName, VectorStore } from "../utils/vector-store";
import { aggregatePerf, appendPerfRows, printDiagnostics, type PerfCsvRow } from "../utils/perf-csv";
import { createLogger } from "../logger";

const logger = createLogger("performance");

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

// Reject unknown flags so typos / unimplemented options fail loudly instead of
// being silently ignored.
const KNOWN_FLAGS = new Set(["topk", "iterations", "services", "consistency", "query", "warm", "attribute-payload", "collections"]);
const unknown = args
  .filter((a) => a.startsWith("--"))
  .map((a) => a.slice(2).split("=")[0]!)
  .filter((name) => !KNOWN_FLAGS.has(name));
if (unknown.length) {
  console.error(
    `Unknown flag(s): ${unknown.map((u) => `--${u}`).join(", ")}. ` +
      `Known: ${[...KNOWN_FLAGS].map((k) => `--${k}`).join(", ")}`,
  );
  process.exit(1);
}

const QUERIES = args.filter((a) => !a.startsWith("--"));
const queries = QUERIES.length ? QUERIES : DEFAULT_QUERIES;
const TOPK = Number(flag("topk", "10"));
const ITERATIONS = Number(flag("iterations", "30"));
const SERVICES = flag("services", "turbopuffer,pinecone")
  .split(",")
  .filter(Boolean) as ServiceName[];
// Turbopuffer read consistency (Pinecone serverless ignores it). Default strong.
const CONSISTENCY = flag("consistency", "strong") as "strong" | "eventual";
// --query="..." runs that single query once per service (ad-hoc latency probe).
const ONESHOT = flag("query", "");
// Native cache prewarm (Turbopuffer hintCacheWarm) is off by default; --warm enables it.
const WARM = args.includes("--warm");
// --attribute-payload=minimal|decent|full (default full): how much per-hit payload
// to return, to weigh search latency against response-payload cost. Shared by every
// query() call below. minimal = id+score only; decent = id+score+content+date; full = all attrs.
const PAYLOAD = flag("attribute-payload", "full") as AttributePayload;
if (!["minimal", "decent", "full"].includes(PAYLOAD)) {
  console.error(`Invalid --attribute-payload: "${PAYLOAD}". Expected one of: minimal, decent, full.`);
  process.exit(1);
}
const QUERY_OPTS = { topK: TOPK, consistency: CONSISTENCY, attributePayload: PAYLOAD };

// --collections=bill (or a CSV) restricts the sweep to specific collections.
// Defaults to the two-namespace set (bill_text, bill_amendment). `bill` targets
// the single-namespace variant — pair it with --services=turbopuffer.
const COLLECTIONS_TO_RUN: CollectionKey[] = (() => {
  const raw = flag("collections", "");
  if (!raw) return COLLECTION_KEYS;
  const requested = raw.split(",").map((c) => c.trim()).filter(Boolean);
  const bad = requested.filter((c) => !(c in COLLECTIONS));
  if (bad.length) {
    console.error(
      `Unknown collection(s): ${bad.join(", ")}. Known: ${Object.keys(COLLECTIONS).join(", ")}`,
    );
    process.exit(1);
  }
  return requested as CollectionKey[];
})();

async function timeIt<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const start = performance.now();
  const result = await fn();
  return [result, performance.now() - start];
}

// Surface a hanging call (e.g. a stuck OpenSearch connection) instead of stalling forever.
const QUERY_TIMEOUT_MS = 20_000;
function withTimeout<T>(label: string, promise: Promise<T>, ms = QUERY_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
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

const round = (n: number) => Math.round(n * 10) / 10;

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

/**
 * One-shot mode (--query="..."): embed the query once, then run it a single time
 * against each collection of each selected service, reporting that single call's
 * latency, hit count, and top score. Honors --warm; otherwise the first call pays
 * connection setup (realistic for a cold ad-hoc query).
 */
async function oneShot(): Promise<void> {
  logger.info("One-shot query", { query: ONESHOT, services: SERVICES, topK: TOPK, consistency: CONSISTENCY, warm: WARM });
  const [vectors, embedMs] = await timeIt(() => embedBatch([ONESHOT]));
  const vector = vectors[0]!;
  console.log(
    `\nQuery: "${ONESHOT}"  (embed ${round(embedMs)}ms, topK=${TOPK}, consistency=${CONSISTENCY}${WARM ? ", warmed" : ""})\n`,
  );

  const rows: Record<string, { "latency(ms)": number; hits: number; "top score": number }> = {};
  for (const service of SERVICES) {
    const stores = Object.fromEntries(
      COLLECTIONS_TO_RUN.map((c) => [c, createStore(service, c)]),
    ) as Record<CollectionKey, VectorStore>;
    if (WARM) {
      logger.info("Warming", { service });
      await Promise.all(COLLECTIONS_TO_RUN.map((c) => stores[c].warm?.().catch((e) => logger.warn("warm failed", { service, collection: c, error: String(e) }))));
    }

    for (const collection of COLLECTIONS_TO_RUN) {
      const label = `${service}:${collection}`;
      logger.info("Querying", { label });
      try {
        const [hits, ms] = await timeIt(() =>
          withTimeout(label, stores[collection].query(vector, QUERY_OPTS)),
        );
        logger.info("Query done", { label, ms: round(ms), hits: hits.length });
        rows[label] = {
          "latency(ms)": round(ms),
          hits: hits.length,
          "top score": Math.round((hits[0]?.score ?? 0) * 1000) / 1000,
        };
      } catch (error) {
        logger.error("Query failed", { label, error: error instanceof Error ? error.message : String(error) });
        rows[label] = { "latency(ms)": -1, hits: -1, "top score": -1 };
      }
    }
  }

  console.log("Single-run query latency:");
  console.table(sortedTable(rows));
}

async function main() {
  if (ONESHOT) return oneShot();

  logger.info("Embedding queries", {
    queries: queries.length,
    services: SERVICES,
    topK: TOPK,
    consistency: CONSISTENCY,
  });
  const [vectors, embedMs] = await timeIt(() => embedBatch(queries));
  console.log(
    `\nEmbedded ${queries.length} queries in ${round(embedMs)}ms ` +
      `(${round(embedMs / queries.length)}ms/query, shared across services)` +
      `${PAYLOAD !== "full" ? ` · payload: ${PAYLOAD}` : ""}\n`,
  );

  // service:collection -> isolated per-call latencies
  const perCall: Record<string, number[]> = {};
  // service -> end-to-end (both collections, in parallel) latencies
  const endToEnd: Record<string, number[]> = {};
  // service -> max of the two component latencies during that same parallel run.
  // End-to-end must wait for both, so it can't beat this max — comparing the two
  // shows the gap is order-statistics ("slower of two"), not Promise.all overhead.
  const endToEndMax: Record<string, number[]> = {};
  // service -> server-side diagnostics from the measured per-collection calls.
  const perfByService: Record<string, QueryPerf[]> = {};

  await Promise.all(SERVICES.map(async (service) => {
    const stores = Object.fromEntries(
      COLLECTIONS_TO_RUN.map((c) => [c, createStore(service, c)]),
    ) as Record<CollectionKey, VectorStore>;
    const onPerf = (p: QueryPerf) => (perfByService[service] ??= []).push(p);
    const measuredOpts = { ...QUERY_OPTS, onPerf };

    // Native cache prewarm (Turbopuffer) only when --warm is passed; off by default.
    if (WARM) await Promise.all(COLLECTIONS_TO_RUN.map((c) => stores[c].warm?.().catch(() => {})));
    // Always prime the HTTP connection with a throwaway query (not measured) so the
    // first measured call doesn't pay TLS/connection setup.
    await Promise.all(
      COLLECTIONS_TO_RUN.map((c) =>
        withTimeout(
          `${service}:${c} warmup`,
          stores[c].query(vectors[0]!, QUERY_OPTS),
        ).catch(() => []),
      ),
    );

    for (let iter = 0; iter < ITERATIONS; iter++) {
      for (const vector of vectors) {
        // Isolated per-collection timing (sequential).
        for (const collection of COLLECTIONS_TO_RUN) {
          const label = `${service}:${collection}`;
          const [, ms] = await timeIt(() =>
            withTimeout(label, stores[collection].query(vector, measuredOpts)),
          );
          (perCall[`${service}:${collection}`] ??= []).push(ms);
        }

        // End-to-end: both collections concurrently (what VectorSearcher does).
        // Time each component within the same parallel run so we can report the
        // combined wall alongside max(components).
        const components: number[] = [];
        const [, combined] = await timeIt(() =>
          Promise.all(
            COLLECTIONS_TO_RUN.map(async (collection) => {
              const label = `${service}:${collection} parallel`;
              const [, ms] = await timeIt(() =>
                withTimeout(label, stores[collection].query(vector, QUERY_OPTS)),
              );
              components.push(ms);
            }),
          ),
        );
        (endToEnd[service] ??= []).push(combined);
        (endToEndMax[service] ??= []).push(Math.max(...components));
      }
    }
  }));

  console.log("Per-collection query latency:");
  const perCollectionRows = Object.fromEntries(Object.entries(perCall).map(([k, v]) => [k, stats(v)]));
  console.table(highlightedStatsTable(perCollectionRows, winnerKeys(perCollectionRows, (key) => key.split(":")[1] ?? key)));

  console.log("\nEnd-to-end search latency (both collections in parallel):");
  const e2eRows: Record<string, ReturnType<typeof stats>> = {};
  for (const service of SERVICES) {
    if (endToEnd[service]) e2eRows[`${service} end-to-end`] = stats(endToEnd[service]!);
    if (endToEndMax[service]) e2eRows[`${service} max(per-collection)`] = stats(endToEndMax[service]!);
  }
  console.table(highlightedStatsTable(e2eRows, winnerKeys(e2eRows, (key) => key.includes("max(per-collection)") ? "max" : "end-to-end")));

  printDiagnostics(perfByService);

  // Persist the per-service end-to-end stats to CSV when a caller (run.sh) sets
  // PERF_CSV. The whole sweep accumulates into one evals/csv/<timestamp>.csv,
  // every row stamped with the shared PERF_RUN_AT so the run groups cleanly.
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
      mode: "unfiltered",
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
      sessions: "",
      since: "",
      until: "",
      warm: WARM,
      ...aggregatePerf(perfByService[service] ?? []),
    };
  });
  await appendPerfRows(path, rows);
  console.log(`\n→ appended ${rows.length} unfiltered row(s) to ${path}`);
}

main().catch((error) => {
  logger.error("Performance run failed", {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exit(1);
});
