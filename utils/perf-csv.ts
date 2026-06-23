/**
 * Single source of truth for the latency-benchmark CSV *write* format, shared by
 * the dashboard orchestrator (scripts/run-eval.ts, one CSV per sweep) and the
 * standalone performance scripts driven by run.sh (which append a row per service
 * as each combo finishes). Keeping the column order and escaping here means the
 * on-disk format has exactly one definition. The reader (src/lib/perf/csv.ts)
 * matches columns by header name, so it stays compatible regardless of order.
 */

import type { QueryPerf } from "./vector-store";

export const PERF_CSV_COLUMNS = [
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
  // Server-side diagnostics (Turbopuffer only; blank for backends that don't
  // report them). The reader matches by header name, so older CSVs without
  // these columns still parse — they just read as blank.
  "cache_temp", // coldest cache_temperature observed across the run's calls
  "exhaustive_max", // max unindexed docs brute-force scanned in any one call
  "server_ms_avg", // mean server_total_ms (excludes network/embedding)
] as const;

export type PerfCsvColumn = (typeof PERF_CSV_COLUMNS)[number];
export type PerfCsvRow = Record<PerfCsvColumn, string | number | boolean>;

/** CSV-shaped summary of a service's per-call QueryPerf samples. */
export type PerfDiagnostics = Pick<PerfCsvRow, "cache_temp" | "exhaustive_max" | "server_ms_avg">;

// hot < warm < cold: report the coldest call so any cache miss is visible.
const TEMP_RANK: Record<string, number> = { hot: 0, warm: 1, cold: 2 };

/**
 * Collapse a service's per-call diagnostics into the three CSV columns. Returns
 * blanks when no backend reported anything (e.g. Pinecone/Qdrant/OpenSearch), so
 * those rows leave the diagnostic columns empty rather than zeroed.
 */
export function aggregatePerf(samples: QueryPerf[]): PerfDiagnostics {
  let coldest = "";
  let coldestRank = -1;
  let exMax = 0;
  let hasEx = false;
  let serverSum = 0;
  let serverN = 0;
  for (const s of samples) {
    if (s.cacheTemperature) {
      const rank = TEMP_RANK[s.cacheTemperature] ?? -1;
      if (rank > coldestRank) {
        coldestRank = rank;
        coldest = s.cacheTemperature;
      }
    }
    if (typeof s.exhaustiveSearchCount === "number") {
      hasEx = true;
      exMax = Math.max(exMax, s.exhaustiveSearchCount);
    }
    if (typeof s.serverTotalMs === "number") {
      serverSum += s.serverTotalMs;
      serverN += 1;
    }
  }
  return {
    cache_temp: coldest,
    exhaustive_max: hasEx ? exMax : "",
    server_ms_avg: serverN ? Math.round((serverSum / serverN) * 10) / 10 : "",
  };
}

export function csvEscape(v: unknown): string {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function serializeRows(rows: PerfCsvRow[]): string {
  return rows.map((r) => PERF_CSV_COLUMNS.map((c) => csvEscape(r[c])).join(",")).join("\n");
}

/** Write a fresh CSV (header + rows), overwriting any existing file at `path`. */
export async function writePerfCsv(path: string, rows: PerfCsvRow[]): Promise<void> {
  await Bun.write(path, `${PERF_CSV_COLUMNS.join(",")}\n${serializeRows(rows)}\n`);
}

/**
 * Append rows to a CSV, writing the header first if the file doesn't exist yet.
 * Lets one ./run.sh accumulate every combo's rows into a single timestamped file.
 * These files are tiny (KBs) and callers within a run never append concurrently,
 * so a read-modify-write is fine.
 */
export async function appendPerfRows(path: string, rows: PerfCsvRow[]): Promise<void> {
  if (rows.length === 0) return;
  const file = Bun.file(path);
  if (await file.exists()) {
    const prev = await file.text();
    const sep = prev.length > 0 && !prev.endsWith("\n") ? "\n" : "";
    await Bun.write(path, `${prev}${sep}${serializeRows(rows)}\n`);
  } else {
    await writePerfCsv(path, rows);
  }
}
