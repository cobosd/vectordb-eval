/**
 * Average metadata size per row (excluding the vector) in each Turbopuffer namespace.
 *
 * Samples rows ordered by id (`rank_by:["id","asc"]` + `id > cursor` paging) with
 * `exclude_attributes:["vector"]`, then measures the JSON-serialized byte size of each
 * row's metadata — every stored attribute except the reserved keys (id, vector, $dist).
 *
 * A sample (not a full scan) is sufficient: per-chunk text is bounded by the chunker, so
 * the per-row metadata size is well-behaved (unlike chunks-per-doc, which is heavy-tailed).
 * id-order ≈ random w.r.t. content (ids are `${uuid}::${chunk_id}`), so the first N rows
 * are an unbiased sample.
 *
 * Size = Buffer.byteLength(JSON.stringify(metadata)) — a reproducible logical size, not
 * Turbopuffer's compressed on-disk footprint.
 *
 * Usage:
 *   bun scripts/metadata-size.ts                     # both collections, 5000-row sample
 *   bun scripts/metadata-size.ts --collection=bill_text --sample=20000
 *   bun scripts/metadata-size.ts --page=2000
 */

import { COLLECTIONS } from "../consts";
import type { CollectionKey } from "../consts";
import { getTurbopuffer } from "../services/turbopuffer/client";

const flag = (name: string, fallback?: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;

const SAMPLE = Math.max(1, Number(flag("sample", "5000")));
const PAGE = Math.max(1, Number(flag("page", "2000")));
const RESERVED = new Set(["id", "vector", "$dist"]);
const ALL = Object.keys(COLLECTIONS) as CollectionKey[];
const only = flag("collection") as CollectionKey | undefined;
if (only && !ALL.includes(only)) throw new Error(`Unknown --collection=${only}. Valid: ${ALL.join(", ")}`);
const COLS = only ? [only] : ALL;

type Result = {
  collection: CollectionKey;
  ns: string;
  n: number;
  approx: number;
  sizes: number[]; // bytes per row
  fieldBytes: Map<string, number>; // summed across sample
};

async function sampleNamespace(collection: CollectionKey): Promise<Result> {
  const nsName = COLLECTIONS[collection].turbopufferNamespace;
  const ns = getTurbopuffer().namespace(nsName);
  const sizes: number[] = [];
  const fieldBytes = new Map<string, number>();
  let approx = 0;
  let cursor: string | null = null;

  while (sizes.length < SAMPLE) {
    let res: any;
    try {
      res = await ns.query({
        rank_by: ["id", "asc"],
        top_k: Math.min(PAGE, SAMPLE - sizes.length),
        exclude_attributes: ["vector"], // everything but the vector
        consistency: { level: "eventual" },
        ...(cursor !== null ? { filters: ["id", "Gt", cursor] } : {}),
      } as any);
    } catch (error: any) {
      if (error?.status === 404) {
        process.stderr.write(`  ${collection}: namespace "${nsName}" does not exist — skipping\n`);
        return { collection, ns: nsName, n: 0, approx: 0, sizes, fieldBytes };
      }
      throw error;
    }

    const rows = res.rows ?? [];
    if (cursor === null) approx = res.performance?.approx_namespace_size ?? res.performance?.approx_row_count ?? 0;
    if (rows.length === 0) break;

    for (const r of rows) {
      const metadata: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(r)) {
        if (RESERVED.has(k)) continue;
        metadata[k] = v;
        fieldBytes.set(k, (fieldBytes.get(k) ?? 0) + Buffer.byteLength(JSON.stringify(v ?? null), "utf8"));
      }
      sizes.push(Buffer.byteLength(JSON.stringify(metadata), "utf8"));
    }
    cursor = String(rows[rows.length - 1].id);
    process.stderr.write(`\r  ${collection}: sampled ${sizes.length.toLocaleString()} rows`);
    if (rows.length < Math.min(PAGE, SAMPLE)) break;
  }
  process.stderr.write("\n");
  return { collection, ns: nsName, n: sizes.length, approx, sizes, fieldBytes };
}

const kb = (bytes: number) => (bytes / 1024).toFixed(2);
const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);
const n = (x: number) => Math.round(x).toLocaleString();

function pct(sorted: number[], p: number) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function main() {
  process.stderr.write(`Sampling metadata size (excl. vector) — sample=${SAMPLE}/ns, page=${PAGE}…\n`);
  const results: Result[] = [];
  for (const c of COLS) results.push(await sampleNamespace(c));

  console.log("\n=== Turbopuffer · metadata size per row (excludes vector) ===");
  for (const r of results) {
    if (!r.n) {
      console.log(`\n${r.collection}  (ns=${r.ns})  — no rows`);
      continue;
    }
    const sorted = [...r.sizes].sort((a, b) => a - b);
    const total = sorted.reduce((a, b) => a + b, 0);
    const avg = total / r.n;
    const topFields = [...r.fieldBytes.entries()]
      .map(([k, b]) => [k, b / r.n] as const)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([k, b]) => `${k} ${Math.round(b)}B`)
      .join(" · ");

    console.log(`\n${r.collection}  (ns=${r.ns})   sample ${n(r.n)} of ~${n(r.approx)} rows`);
    console.log(`  avg metadata          ${kb(avg)} kB  (${n(avg)} B)`);
    console.log(`  median / p95 / max    ${kb(pct(sorted, 50))} / ${kb(pct(sorted, 95))} / ${kb(sorted[sorted.length - 1])} kB`);
    if (r.approx) console.log(`  est. namespace total  ~${mb(avg * r.approx)} MB  (avg × ${n(r.approx)} rows)`);
    console.log(`  top fields (avg)      ${topFields}`);
  }
  console.log();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
