/**
 * Single source of truth for the latency-benchmark CSV *write* format, shared by
 * the dashboard orchestrator (scripts/run-eval.ts, one CSV per sweep) and the
 * standalone performance scripts driven by run.sh (which append a row per service
 * as each combo finishes). Keeping the column order and escaping here means the
 * on-disk format has exactly one definition. The reader (src/lib/perf/csv.ts)
 * matches columns by header name, so it stays compatible regardless of order.
 */

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
] as const;

export type PerfCsvColumn = (typeof PERF_CSV_COLUMNS)[number];
export type PerfCsvRow = Record<PerfCsvColumn, string | number | boolean>;

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
