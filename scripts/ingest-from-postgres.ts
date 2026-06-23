import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Prisma } from "@prisma/client";
import { COLLECTIONS, type CollectionKey } from "../consts";
import { prisma } from "../prisma/client";
import { streamChunksForBills } from "../utils/get-chunks";
import { decodeVector, encodeVector } from "../utils/vector-cache";
import { toEpoch } from "../utils/bill-metadata";
import { ALL_SERVICES, VectorIndexer } from "../utils/vector-indexer";
import { ProgressBar } from "../utils/progress";
import type { MetadataValue, ServiceName, VectorRow } from "../utils/vector-store";
import { createLogger, logger as rootLogger } from "../logger";

const logger = createLogger("ingest-from-postgres");

const DATA_DIR = new URL("../data/", import.meta.url);
// Stage 1 dumps fully-assembled rows (id + vector + metadata, tagged with their
// collection) here as JSONL; stage 2 reads them back and ingests into the stores.
const DUMP_FILE = new URL("data-ingest-100k-bills.jsonl", DATA_DIR).pathname;
// Sidecar holding per-collection row counts, so stage 2 can show progress-bar
// totals without re-scanning the (multi-GB) dump.
const MANIFEST_FILE = `${DUMP_FILE}.manifest.json`;

// How many distinct bills (present in bill_embedding) to select & ingest.
const BILL_LIMIT = process.env.BILL_LIMIT ? Number(process.env.BILL_LIMIT) : 100_000;
// bill_uuids per chunk query (bounds the IN list and the rows held at once).
const UUID_BATCH_SIZE = 100;
// bill_uuids per bill-metadata query (small rows, so a larger batch is fine).
const META_BATCH_SIZE = 1000;
// Rows buffered before a flush to the stores during ingest. This is also
// Turbopuffer's per-write request size — it sends the whole buffer in one write()
// (512MB / ~no row cap), while Pinecone/Qdrant/OpenSearch sub-batch below it with
// their own caps (100/500/1000). Override via env to sweep it as an eval variable.
const UPSERT_BATCH_SIZE = process.env.UPSERT_BATCH_SIZE ? Number(process.env.UPSERT_BATCH_SIZE) : 1000;

// Both collections draw from bill_embedding (BILL_TEXT / BILL_AMENDMENT doc_type).
// --bill-text / --bill-amendment select a subset (e.g. to run the two collections
// as separate processes); neither flag means both.
const COLLECTIONS_TO_INGEST: CollectionKey[] = (() => {
  const selected: CollectionKey[] = [];
  if (process.argv.includes("--bill-text")) selected.push("bill_text");
  if (process.argv.includes("--bill-amendment")) selected.push("bill_amendment");
  return selected.length ? selected : ["bill_text", "bill_amendment"];
})();

// Per-collection date field name carried in metadata.
const DATE_FIELD: Record<CollectionKey, string> = {
  bill_text: "bill_text_date",
  bill_amendment: "amendment_date",
};

// bill.progress_status (db enum) values that mean the bill can no longer advance.
// Best-effort interpretation: failed, vetoed, or session adjourned before passage.
// Raw `progress_status` is also carried in metadata so consumers can re-derive.
const DEAD_PROGRESS_STATUSES = new Set([
  "failed",
  "passedsecondchamber_vetoed",
  "introduced_adjournment_passed",
  "passedfirstchamber_adjournment_passed",
]);

// --reset wipes each collection before ingesting (stage 2).
const RESET = process.argv.includes("--reset");
// Target a subset of stores, via either a CSV (--services=turbopuffer,pinecone) or
// individual boolean flags (--pinecone --qdrant). Neither means all 4. Selecting a
// single service is the way to benchmark one backend's ingest time in isolation.
const servicesArg = process.argv.find((a) => a.startsWith("--services="));
const SERVICES: ServiceName[] | undefined = (() => {
  const fromCsv = servicesArg ? servicesArg.slice("--services=".length).split(",").filter(Boolean) : [];
  const fromFlags = ALL_SERVICES.filter((s) => process.argv.includes(`--${s}`));
  const selected = [...new Set([...fromCsv, ...fromFlags])] as ServiceName[];
  const unknown = selected.filter((s) => !ALL_SERVICES.includes(s));
  if (unknown.length) throw new Error(`Unknown service(s): ${unknown.join(", ")}. Valid: ${ALL_SERVICES.join(", ")}`);
  return selected.length ? selected : undefined;
})();
// --stage=dump | ingest | both. Default runs both (dump, then ingest); split so a
// re-ingest can replay data-ingest-100k-bills.jsonl without re-querying Postgres.
const stageArg = process.argv.find((a) => a.startsWith("--stage="));
const STAGE = stageArg ? stageArg.slice("--stage=".length) : "both";
if (!["dump", "ingest", "both"].includes(STAGE)) {
  throw new Error(`Unknown --stage="${STAGE}". Valid: dump, ingest, both`);
}

/** One assembled row as serialized to the dump file. `v` is a base64 Float32 blob. */
type DumpRow = { collection: CollectionKey; id: string; v: string; metadata: Record<string, MetadataValue> };

/** Bill-level metadata (joined from the `bill` table), keyed by bill_uuid. */
type BillMeta = Record<string, MetadataValue>;
/** Doc-level metadata (from bill_text / bill_amendment), keyed by doc_uuid. */
type DocMeta = { hide: boolean; s3_url: string; summary: string; date: string };

/** Format a Postgres date/timestamp (Date | string | null) as a full ISO string. */
function toIsoString(value: unknown): string {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return "";
}

/** Like toIsoString but date-only (YYYY-MM-DD), for @db.Date columns. */
function toDateOnly(value: unknown): string {
  const iso = toIsoString(value);
  return iso ? iso.slice(0, 10) : "";
}

/** Select the first `limit` distinct bill_uuids present in bill_embedding. */
async function selectBillUuids(limit: number): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ bill_uuid: string }[]>`
    SELECT DISTINCT bill_uuid FROM bill_embedding ORDER BY bill_uuid LIMIT ${limit}
  `;
  logger.info("Selected bills from bill_embedding", { selected: rows.length, limit });
  return rows.map((r) => r.bill_uuid);
}

/** Raw row shape from the `bill` metadata query. */
type BillMetaRow = {
  bill_uuid: string;
  bill_number_normalized: string | null;
  session_id: number;
  state_id: number;
  status_id: number;
  current_body_id: number;
  pending_directories_committees_id: number | null;
  progress_status: string | null;
  is_active: boolean | null;
  notification_action_time: Date | string | null;
};

/**
 * Pre-fetch bill-level metadata for every selected bill into a map (small rows,
 * so the whole 100k set fits comfortably in memory and is shared by both passes).
 */
async function fetchBillMeta(billUuids: string[]): Promise<Map<string, BillMeta>> {
  const map = new Map<string, BillMeta>();
  for (let i = 0; i < billUuids.length; i += META_BATCH_SIZE) {
    const slice = billUuids.slice(i, i + META_BATCH_SIZE);
    if (slice.length === 0) continue;

    const rows = await prisma.$queryRaw<BillMetaRow[]>`
      SELECT uuid AS bill_uuid, bill_number_normalized, session_id, state_id, status_id,
             current_body_id, pending_directories_committees_id,
             progress_status::text AS progress_status, is_active, notification_action_time
      FROM bill
      WHERE uuid IN (${Prisma.join(slice)})
    `;

    for (const r of rows) {
      const nat = toIsoString(r.notification_action_time);
      map.set(r.bill_uuid, {
        bill_number_normalized: r.bill_number_normalized ?? "",
        session_id: r.session_id ?? 0,
        state_id: r.state_id ?? 0,
        status_id: r.status_id ?? 0,
        current_body_id: r.current_body_id ?? 0,
        // Int? — coalesced to 0 (no null; both Pinecone & the FTS schema want a value).
        pending_directories_committees_id: r.pending_directories_committees_id ?? 0,
        progress_status: r.progress_status ?? "",
        has_dead_progress_status: r.progress_status ? DEAD_PROGRESS_STATUSES.has(r.progress_status) : false,
        is_active: r.is_active ?? false,
        notification_action_time: nat,
        // Numeric epoch (ms) so backends that can't range-filter a string still can.
        notification_action_time_epoch: toEpoch(nat),
      });
    }
    logger.info("Fetched bill metadata", { fetched: map.size, of: billUuids.length });
  }
  return map;
}

/** Raw row shape from the doc-level (bill_text / bill_amendment) metadata query. */
type DocMetaRow = { doc_uuid: string; hide: boolean | null; s3_url: string | null; summary: string | null; doc_date: Date | string | null };

/** Fetch doc-level metadata for a set of doc_uuids (the PK of each doc table). */
async function fetchDocMeta(collection: CollectionKey, docUuids: string[]): Promise<Map<string, DocMeta>> {
  const map = new Map<string, DocMeta>();
  if (docUuids.length === 0) return map;

  const rows =
    collection === "bill_text"
      ? await prisma.$queryRaw<DocMetaRow[]>`
          SELECT doc_uuid, hide, s3_url, summary, bill_text_date AS doc_date
          FROM bill_text WHERE doc_uuid IN (${Prisma.join(docUuids)})`
      : await prisma.$queryRaw<DocMetaRow[]>`
          SELECT doc_uuid, hide, s3_url, summary, amendment_date AS doc_date
          FROM bill_amendment WHERE doc_uuid IN (${Prisma.join(docUuids)})`;

  for (const r of rows) {
    map.set(r.doc_uuid, {
      hide: r.hide ?? false,
      s3_url: r.s3_url ?? "",
      summary: r.summary ?? "",
      date: toDateOnly(r.doc_date),
    });
  }
  return map;
}

/**
 * Stage 1: select the bills, join their chunks (both doc types) with full
 * Postgres metadata, and write fully-assembled rows to the dump file.
 */
async function stageDump(): Promise<void> {
  const billUuids = await selectBillUuids(BILL_LIMIT);
  const billMeta = await fetchBillMeta(billUuids);

  await mkdir(dirname(DUMP_FILE), { recursive: true });
  const sink = Bun.file(DUMP_FILE).writer();

  let written = 0;
  let missingBillMeta = 0;
  const counts: Record<string, number> = { bill_text: 0, bill_amendment: 0 };

  for (const collection of COLLECTIONS_TO_INGEST) {
    const { docType } = COLLECTIONS[collection];
    const dateField = DATE_FIELD[collection];
    logger.info("Dumping collection", { collection, docType, bills: billUuids.length });

    for await (const batch of streamChunksForBills(docType, billUuids, { uuidBatchSize: UUID_BATCH_SIZE })) {
      const docUuids = [...new Set(batch.map((c) => c.doc_uuid))];
      const docMeta = await fetchDocMeta(collection, docUuids);

      for (const c of batch) {
        const bm = billMeta.get(c.bill_uuid);
        if (!bm) missingBillMeta++;
        const dm = docMeta.get(c.doc_uuid);
        const metadata: Record<string, MetadataValue> = {
          doc_uuid: c.doc_uuid,
          bill_uuid: c.bill_uuid,
          chunk_id: c.chunk_id,
          chunk_text: c.content,
          ...(bm ?? {}),
          hide: dm?.hide ?? false,
          s3_url: dm?.s3_url ?? "",
          summary: dm?.summary ?? "",
          [dateField]: dm?.date ?? "",
        };
        const row: DumpRow = { collection, id: `${c.doc_uuid}::${c.chunk_id}`, v: encodeVector(c.embedding), metadata };
        sink.write(JSON.stringify(row) + "\n");
        written++;
        counts[collection]!++;
      }
      logger.info("Dump progress", { collection, rows: counts[collection] });
    }
  }

  await sink.end();
  await writeManifest(counts);
  logger.info("Dump complete", { file: DUMP_FILE, written, counts, missingBillMeta });
}

/** Per-collection row counts persisted alongside the dump. */
type Manifest = { counts: Record<string, number>; total: number; billLimit: number };

async function writeManifest(counts: Record<string, number>): Promise<void> {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const manifest: Manifest = { counts, total, billLimit: BILL_LIMIT };
  await Bun.write(MANIFEST_FILE, JSON.stringify(manifest, null, 2));
}

async function readManifest(): Promise<Manifest | null> {
  const f = Bun.file(MANIFEST_FILE);
  if (!(await f.exists())) return null;
  try {
    return (await f.json()) as Manifest;
  } catch {
    return null;
  }
}

/**
 * Count rows per collection by scanning the dump. Only used as a fallback when no
 * manifest exists (e.g. a dump produced before manifests were written). Detects the
 * collection from each line's leading key to avoid a full JSON.parse per row.
 */
async function countDumpRows(): Promise<Record<string, number>> {
  logger.info("No manifest found; counting dump rows for progress totals (one-time scan)", { file: DUMP_FILE });
  const prefixes = COLLECTIONS_TO_INGEST.map((c) => [c, `{"collection":"${c}"`] as const);
  const counts: Record<string, number> = Object.fromEntries(COLLECTIONS_TO_INGEST.map((c) => [c, 0]));
  let scanned = 0;

  const rl = createInterface({ input: createReadStream(DUMP_FILE), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let coll = prefixes.find(([, p]) => line.startsWith(p))?.[0] as string | undefined;
    if (!coll) {
      try {
        coll = (JSON.parse(line) as DumpRow).collection;
      } catch {
        continue;
      }
    }
    if (coll in counts) counts[coll]!++;
    if (++scanned % 500_000 === 0) logger.info("Counting…", { scanned });
  }
  rl.close();
  return counts;
}

/** Per-collection totals for the progress bars: manifest if present, else a one-time scan. */
async function resolveTotals(): Promise<Record<string, number>> {
  const manifest = await readManifest();
  if (manifest?.counts) {
    logger.info("Loaded row totals from manifest", { counts: manifest.counts });
    return manifest.counts;
  }
  const counts = await countDumpRows();
  await writeManifest(counts).catch(() => {}); // cache so re-ingests are instant
  logger.info("Counted row totals", { counts });
  return counts;
}

/**
 * Stage 2: replay the dump file, routing each row to its collection's indexer and
 * fanning rows out to all selected vector stores in batches.
 */
async function stageIngest(): Promise<void> {
  const indexers = new Map<CollectionKey, VectorIndexer>();
  for (const collection of COLLECTIONS_TO_INGEST) {
    const indexer = new VectorIndexer(collection, { services: SERVICES });
    await indexer.ensure();
    if (RESET) await indexer.reset();
    indexers.set(collection, indexer);
  }
  logger.info("Ingesting from dump", {
    file: DUMP_FILE,
    services: indexers.get(COLLECTIONS_TO_INGEST[0]!)!.services,
    reset: RESET,
  });

  // One progress bar per collection, each with its known total (rows in the dump).
  const totals = await resolveTotals();
  const labelWidth = Math.max(...COLLECTIONS_TO_INGEST.map((c) => c.length));
  const bars = new Map<CollectionKey, ProgressBar>(
    COLLECTIONS_TO_INGEST.map((c) => [c, new ProgressBar(c.padEnd(labelWidth), { total: totals[c] })]),
  );

  const buffers = new Map<CollectionKey, VectorRow[]>(COLLECTIONS_TO_INGEST.map((c) => [c, []]));
  const ingested = new Map<CollectionKey, number>(COLLECTIONS_TO_INGEST.map((c) => [c, 0]));

  // Hand the terminal to the bars: on a TTY, silence the winston transport while
  // the in-place bar renders so per-batch log lines don't corrupt the redraw.
  // Restored in `finally`, so a thrown error still surfaces via the top-level catch.
  const transport = rootLogger.transports[0];
  const live = Boolean(process.stderr.isTTY);
  const prevSilent = transport?.silent;
  if (live && transport) transport.silent = true;

  // Rows are grouped by collection in the dump; render only the active bar so the
  // two bars never fight over the same TTY line.
  let active: CollectionKey | null = null;
  const flush = async (collection: CollectionKey) => {
    const buf = buffers.get(collection)!;
    if (buf.length === 0) return;
    await indexers.get(collection)!.upsert(buf);
    ingested.set(collection, ingested.get(collection)! + buf.length);
    if (active && active !== collection) bars.get(active)!.done();
    active = collection;
    bars.get(collection)!.tick(buf.length);
    buffers.set(collection, []);
  };

  // Cheap collection detection from the line prefix (collection is always the first
  // key), so a single-collection ingest skips the other collection's rows WITHOUT a
  // full JSON.parse. Matters because the dump groups collections: a --bill-amendment
  // run would otherwise parse all ~13GB of bill_text lines just to discard them.
  const selectedPrefixes = COLLECTIONS_TO_INGEST.map((c) => `{"collection":"${c}"`);

  const wallStart = performance.now();
  try {
    const rl = createInterface({ input: createReadStream(DUMP_FILE), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!selectedPrefixes.some((p) => line.startsWith(p))) continue; // skip blanks + other collections
      const rec = JSON.parse(line) as DumpRow;
      const buf = buffers.get(rec.collection);
      if (!buf) continue; // row for a collection we're not ingesting
      buf.push({ id: rec.id, vector: decodeVector(rec.v), metadata: rec.metadata });
      if (buf.length >= UPSERT_BATCH_SIZE) await flush(rec.collection);
    }
    rl.close();
    for (const collection of COLLECTIONS_TO_INGEST) await flush(collection);
  } finally {
    for (const bar of bars.values()) bar.done();
    if (transport) transport.silent = prevSilent;
  }

  const wallMs = performance.now() - wallStart;

  // Aggregate per-service upsert cost across collections for the benchmark summary.
  const perService = new Map<ServiceName, { ms: number; rows: number }>();
  for (const indexer of indexers.values()) {
    for (const t of indexer.getTimings()) {
      const agg = perService.get(t.service) ?? { ms: 0, rows: 0 };
      agg.ms += t.ms;
      agg.rows += t.rows;
      perService.set(t.service, agg);
    }
  }

  const summary = [...perService.entries()]
    .map(([service, t]) => ({
      service,
      rows: t.rows,
      seconds: Number((t.ms / 1000).toFixed(1)),
      rowsPerSec: Math.round(t.rows / (t.ms / 1000 || 1)),
    }))
    .sort((a, b) => b.seconds - a.seconds);

  logger.info("Ingest complete", {
    collections: COLLECTIONS_TO_INGEST,
    totals: Object.fromEntries(ingested),
    wallSeconds: Number((wallMs / 1000).toFixed(1)),
    perService: summary,
  });

  // Human-readable per-service breakdown (cumulative time in upsert; runs concurrent
  // when ingesting >1 service, so columns can sum past wall-clock).
  console.log("\nPer-service ingest timing:");
  console.table(
    Object.fromEntries(
      summary.map((s) => [s.service, { rows: s.rows, seconds: s.seconds, "rows/s": s.rowsPerSec }]),
    ),
  );
  console.log(`wall-clock: ${(wallMs / 1000).toFixed(1)}s for ${COLLECTIONS_TO_INGEST.join(" + ")}\n`);
}

async function main() {
  if (STAGE === "dump" || STAGE === "both") await stageDump();
  if (STAGE === "ingest" || STAGE === "both") await stageIngest();
  await prisma.$disconnect();
  logger.info("Done", { stage: STAGE, billLimit: BILL_LIMIT });
}

if (import.meta.main) {
  main().catch(async (error) => {
    logger.error("Ingest failed", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  });
}
