import type { EvalRow } from "@/lib/eval-data";
import type { RunResultRow } from "./types";

/** Parse a single CSV line, honoring double-quoted fields. */
function parseLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/** Parse a run-eval CSV (header + rows) into typed rows. */
export function parseCsv(text: string): RunResultRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const header = parseLine(lines[0]!);
  const idx = (name: string) => header.indexOf(name);
  const col = {
    run_at: idx("run_at"),
    mode: idx("mode"),
    topK: idx("topK"),
    iters: idx("iters"),
    service: idx("service"),
    consistency: idx("consistency"),
    avg: idx("avg_ms"),
    p50: idx("p50_ms"),
    p95: idx("p95_ms"),
    max: idx("max_ms"),
    min: idx("min_ms"),
    calls: idx("calls"),
    queries: idx("queries"),
    sessions: idx("sessions"),
    since: idx("since"),
    until: idx("until"),
    warm: idx("warm"),
  };

  const rows: RunResultRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const c = parseLine(lines[i]!);
    const num = (j: number) => Number(c[j] ?? "");
    const str = (j: number) => (j >= 0 ? c[j] ?? "" : "");
    const row: RunResultRow = {
      run_at: str(col.run_at),
      mode: str(col.mode) as RunResultRow["mode"],
      topK: num(col.topK),
      iters: num(col.iters),
      service: str(col.service) as RunResultRow["service"],
      consistency: str(col.consistency) as RunResultRow["consistency"],
      avg_ms: num(col.avg),
      p50_ms: num(col.p50),
      p95_ms: num(col.p95),
      max_ms: num(col.max),
      min_ms: num(col.min),
      calls: num(col.calls),
      queries: num(col.queries),
      sessions: str(col.sessions),
      since: str(col.since),
      until: str(col.until),
      warm: str(col.warm) === "true",
    };
    if (Number.isNaN(row.avg_ms) || !row.service) continue;
    rows.push(row);
  }
  return rows;
}

/** Map a run/CSV row to the dashboard's EvalRow so the existing charts/table work. */
export function toEvalRow(r: RunResultRow): EvalRow {
  return {
    id: `${r.mode}-${r.topK}-${r.iters}-${r.service}-${r.consistency}`,
    mode: r.mode,
    topK: r.topK,
    iters: r.iters,
    service: r.service,
    consistency: r.consistency,
    avg: r.avg_ms,
    p50: r.p50_ms,
    p95: r.p95_ms,
    max: r.max_ms,
  };
}
