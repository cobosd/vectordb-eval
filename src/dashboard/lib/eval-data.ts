/**
 * Parses a latency eval markdown file (see evals/*.md) into structured data the
 * dashboard can render. Kept framework-free so it can run on the Bun server and
 * its types can be imported (type-only) by the frontend.
 */

export type Mode = "unfiltered" | "filtered";
export type Service = "turbopuffer" | "pinecone" | "qdrant" | "opensearch";
export type Consistency = "eventual" | "strong" | null;

export interface EvalRow {
  /** stable id derived from the dimensions, handy as a table/react key */
  id: string;
  mode: Mode;
  topK: number;
  iters: number;
  service: Service;
  consistency: Consistency;
  avg: number;
  p50: number;
  p95: number;
  max: number;
}

export interface EvalDoc {
  /** source file name, e.g. 2026-06-17_132946.md */
  file: string;
  title: string;
  /** markdown before the results table (setup / disclaimer) */
  intro: string;
  /** markdown after the results table (observations) */
  notes: string;
  rows: EvalRow[];
}

const num = (s: string): number => {
  const n = Number(s.replace(/[, ]/g, ""));
  return Number.isFinite(n) ? n : NaN;
};

function parseConsistency(s: string): Consistency {
  const v = s.trim().toLowerCase();
  if (v === "eventual") return "eventual";
  if (v === "strong") return "strong";
  return null; // "—" or empty
}

/** Split a markdown table row "| a | b |" into trimmed cells. */
function cells(line: string): string[] {
  return line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((c) => c.trim());
}

const isTableRow = (l: string) => /^\s*\|/.test(l);
const isSeparatorRow = (l: string) => /^\s*\|[\s:|-]+\|?\s*$/.test(l);

export function parseEvalMarkdown(markdown: string, file = ""): EvalDoc {
  const lines = markdown.split(/\r?\n/);

  // Title = first H1
  const titleLine = lines.find((l) => /^#\s+/.test(l));
  const title = titleLine ? titleLine.replace(/^#\s+/, "").trim() : file;

  // Locate the results table: a contiguous block of table rows containing a
  // separator row. We take the first such block.
  let start = -1;
  let end = -1;
  for (let i = 0; i < lines.length; i++) {
    if (isTableRow(lines[i]!)) {
      if (start === -1) start = i;
      end = i;
    } else if (start !== -1) {
      break;
    }
  }

  const rows: EvalRow[] = [];
  if (start !== -1) {
    const tableLines = lines.slice(start, end + 1).filter(isTableRow);
    // Header-driven parsing so we tolerate schema differences across evals
    // (e.g. an older table without a Consistency column).
    const header = cells(tableLines[0] ?? "").map((h) => h.toLowerCase());
    const col = (name: string) => header.indexOf(name);
    const idx = {
      mode: col("mode"),
      topK: col("topk"),
      iters: col("iters"),
      service: col("service"),
      consistency: col("consistency"),
      avg: col("avg"),
      p50: col("p50"),
      p95: col("p95"),
      max: col("max"),
    };

    const dataLines = tableLines.filter((l, i) => i >= 1 && !isSeparatorRow(l));
    for (const l of dataLines) {
      const c = cells(l);
      const at = (i: number) => (i >= 0 ? c[i] ?? "" : "");
      const mode = at(idx.mode);
      const service = at(idx.service);
      const consistency =
        idx.consistency >= 0 ? at(idx.consistency) : "";
      const row: EvalRow = {
        id: `${mode}-${at(idx.topK)}-${at(idx.iters)}-${service}-${consistency || "na"}`,
        mode: mode as Mode,
        topK: num(at(idx.topK)),
        iters: num(at(idx.iters)),
        service: service.toLowerCase() as Service,
        consistency: parseConsistency(consistency),
        avg: num(at(idx.avg)),
        p50: num(at(idx.p50)),
        p95: num(at(idx.p95)),
        max: num(at(idx.max)),
      };
      if (Number.isNaN(row.avg) || !row.service) continue; // skip stragglers
      rows.push(row);
    }
  }

  // intro = lines after title, before the table (skip the title line itself)
  const titleIdx = titleLine ? lines.indexOf(titleLine) : -1;
  const introLines = lines.slice(titleIdx + 1, start === -1 ? lines.length : start);
  const notesLines = end === -1 ? [] : lines.slice(end + 1);

  return {
    file,
    title,
    intro: introLines.join("\n").trim(),
    notes: notesLines.join("\n").trim(),
    rows,
  };
}
