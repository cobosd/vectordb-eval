/**
 * Average number of chunks per doc_uuid, read directly from Turbopuffer.
 *
 * Each stored row is one chunk; ingest builds the row id as `${doc_uuid}::${chunk_id}`
 * (see scripts/ingest-from-postgres.ts), so the parent document is just the id prefix.
 * doc_uuid is NOT a declared, queryable attribute, so we recover it from the id.
 *
 * Method: page through every row ordered by id (`rank_by: ["id","asc"]` + an
 * `id > cursor` range filter), pulling ids only. This is an exact full scan — it
 * doesn't rely on group_by/aggregate top-k caps, which would undercount distinct docs.
 * avg chunks/doc = total rows / distinct doc_uuids.
 *
 * Usage:
 *   bun scripts/chunks-per-doc.ts                       # both collections
 *   bun scripts/chunks-per-doc.ts --collection=bill_text
 *   bun scripts/chunks-per-doc.ts --page=1000           # rows per request (default 1000)
 *
 * Needs the same TURBOPUFFER_* env as the rest of the suite (auto-loaded from .env).
 */

import { COLLECTIONS } from "../consts";
import type { CollectionKey } from "../consts";
import { getTurbopuffer } from "../services/turbopuffer/client";

const flag = (name: string, fallback?: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;

const PAGE = Math.max(1, Number(flag("page", "1000")));
const ALL = Object.keys(COLLECTIONS) as CollectionKey[];
const only = flag("collection") as CollectionKey | undefined;
if (only && !ALL.includes(only)) {
  throw new Error(`Unknown --collection=${only}. Valid: ${ALL.join(", ")}`);
}
const COLS = only ? [only] : ALL;

/** doc_uuid = everything before the final "::" in the row id. */
function docOf(id: string): string {
  const i = id.lastIndexOf("::");
  return i === -1 ? id : id.slice(0, i);
}

type ScanResult = { collection: CollectionKey; ns: string; perDoc: Map<string, number>; total: number; approx: number };

async function scan(collection: CollectionKey): Promise<ScanResult> {
  const nsName = COLLECTIONS[collection].turbopufferNamespace;
  const ns = getTurbopuffer().namespace(nsName);
  const perDoc = new Map<string, number>();
  let total = 0;
  let approx = 0;
  let cursor: string | null = null;

  for (;;) {
    let res: any;
    try {
      res = await ns.query({
        rank_by: ["id", "asc"],
        top_k: PAGE,
        include_attributes: false, // ids only — smallest possible payload
        consistency: { level: "eventual" },
        ...(cursor !== null ? { filters: ["id", "Gt", cursor] } : {}),
      } as any);
    } catch (error: any) {
      if (error?.status === 404) {
        process.stderr.write(`\r  ${collection}: namespace "${nsName}" does not exist — skipping\n`);
        return { collection, ns: nsName, perDoc, total: 0, approx: 0 };
      }
      throw error;
    }

    const rows = res.rows ?? [];
    if (cursor === null) approx = res.performance?.approx_row_count ?? res.performance?.approx_namespace_size ?? 0;
    if (rows.length === 0) break;

    for (const r of rows) {
      total++;
      const d = docOf(String(r.id));
      perDoc.set(d, (perDoc.get(d) ?? 0) + 1);
    }
    cursor = String(rows[rows.length - 1].id);
    process.stderr.write(`\r  ${collection}: ${total.toLocaleString()} rows · ${perDoc.size.toLocaleString()} docs`);
    if (rows.length < PAGE) break;
  }
  process.stderr.write("\n");
  return { collection, ns: nsName, perDoc, total, approx };
}

function summarize(perDoc: Map<string, number>) {
  const counts = [...perDoc.values()].sort((a, b) => a - b);
  const docs = counts.length;
  const total = counts.reduce((a, b) => a + b, 0);
  return {
    docs,
    total,
    avg: docs ? total / docs : 0,
    median: docs ? counts[Math.floor(docs / 2)] : 0,
    min: counts[0] ?? 0,
    max: counts[docs - 1] ?? 0,
  };
}

const n = (x: number) => x.toLocaleString();
const f2 = (x: number) => x.toFixed(2);

async function main() {
  process.stderr.write(`Scanning Turbopuffer (page=${PAGE}) — id prefix = doc_uuid…\n`);
  const results: ScanResult[] = [];
  for (const c of COLS) results.push(await scan(c));

  const combined = new Map<string, number>();
  for (const r of results) for (const [d, c] of r.perDoc) combined.set(d, (combined.get(d) ?? 0) + c);

  const line = (label: string, s: ReturnType<typeof summarize>, approx?: number) => {
    console.log(`\n${label}`);
    console.log(`  chunks (rows)      ${n(s.total)}${approx ? `   (approx_row_count ${n(approx)})` : ""}`);
    console.log(`  distinct doc_uuid  ${n(s.docs)}`);
    console.log(`  avg chunks/doc     ${f2(s.avg)}`);
    console.log(`  median / min / max ${n(s.median)} / ${n(s.min)} / ${n(s.max)}`);
  };

  console.log("\n=== Turbopuffer · chunks per doc_uuid ===");
  for (const r of results) line(`${r.collection}  (ns=${r.ns})`, summarize(r.perDoc), r.approx);
  if (results.length > 1) line("combined", summarize(combined));
  console.log();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
