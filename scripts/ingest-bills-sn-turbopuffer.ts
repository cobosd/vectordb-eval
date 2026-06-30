/**
 * Backfill bill chunk embeddings into a SINGLE Turbopuffer namespace.
 *
 * Single-namespace ("sn") variant of ingest-bills-turbopuffer.ts. Where that
 * script splits the two doc types into separate namespaces (`bill_text`,
 * `bill_amendment`), this one writes BOTH into one namespace (default `bill`) and
 * keeps the doc_type discriminator as a filterable `doc_type` attribute, so a query
 * can scope to one type with a filter instead of choosing a namespace.
 *
 * `bill_embedding` holds precomputed chunks + 1536-dim embeddings for the two doc
 * types: BILL_TEXT and BILL_AMENDMENT. This script reads the chunks, joins
 * bill-level metadata (from `bill`), and upserts one Turbopuffer row per chunk.
 *
 * Row id is `${doc_uuid}::${chunk_id}` (the established bill convention — a bill can
 * have many docs, so doc_uuid keys the row, not bill_uuid), so re-runs are
 * idempotent.
 *
 * Only ACTIVE bills are written: prod's retrieval always ANDs `is_active = true`,
 * so inactive bills are dropped at selection time rather than stored as a flag.
 *
 * Usage:
 *   bun scripts/ingest-bills-sn-turbopuffer.ts                       # both doc types → `bill`
 *   bun scripts/ingest-bills-sn-turbopuffer.ts --bill-text           # only BILL_TEXT
 *   bun scripts/ingest-bills-sn-turbopuffer.ts --bill-amendment      # only BILL_AMENDMENT
 *   bun scripts/ingest-bills-sn-turbopuffer.ts --namespace=bill      # target ns (default: bill)
 *   bun scripts/ingest-bills-sn-turbopuffer.ts --skip-file=PATH      # skip a bill_uuid list
 *   bun scripts/ingest-bills-sn-turbopuffer.ts --start=2025-01-01 --end=2025-01-31
 *   bun scripts/ingest-bills-sn-turbopuffer.ts --limit=100           # at most N bills (per doc type)
 *   bun scripts/ingest-bills-sn-turbopuffer.ts --reset               # wipe namespace first
 *   bun scripts/ingest-bills-sn-turbopuffer.ts --dry-run             # print bill_uuids and exit
 *
 * Needs DB_URL + TURBOPUFFER_API_KEY in .env (auto-loaded by Bun).
 */

import { Prisma } from "@prisma/client";
import { prisma } from "../prisma/client";
import { COLLECTIONS, EMBEDDING_DIMENSIONS, type CollectionKey } from "../consts";
import { streamChunksForBills } from "../utils/get-chunks";
import { getTurbopuffer } from "../services/turbopuffer/client";
import { encodeVector } from "../utils/vector-cache";
import { ProgressBar } from "../utils/progress";
import type { MetadataValue, VectorRow } from "../utils/vector-store";
import { createLogger } from "../logger";

const logger = createLogger("ingest-bills-sn-turbopuffer");

// --- flags -----------------------------------------------------------------

const flag = (name: string, fallback?: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;

const NAMESPACE = flag("namespace", "bill")!;
const START = flag("start"); // inclusive YYYY-MM-DD, filters bill.notification_action_time
const END = flag("end"); // inclusive YYYY-MM-DD
const LIMIT = flag("limit") ? Number(flag("limit")) : null; // cap on # of bills, per doc type
// Optional progress/done file (one bill_uuid per line) whose bills are skipped, so
// an already-ingested set isn't re-upserted. No default — a plain run ingests
// everything. Pass --skip-file=PATH to resume against a prior run.
const SKIP_FILE = flag("skip-file") || undefined;
const RESET = process.argv.includes("--reset");
const DRY_RUN = process.argv.includes("--dry-run");

// Which doc types to ingest into the namespace. Default both; --bill-text /
// --bill-amendment narrow.
const COLLECTIONS_TO_INGEST: CollectionKey[] = (() => {
  const selected: CollectionKey[] = [];
  if (process.argv.includes("--bill-text")) selected.push("bill_text");
  if (process.argv.includes("--bill-amendment")) selected.push("bill_amendment");
  return selected.length ? selected : ["bill_text", "bill_amendment"];
})();

// Rows per Turbopuffer write(). Turbopuffer sends the whole buffer in one request
// (512MB / no row cap); 1000 keeps each write comfortably sized. Override to sweep.
const UPSERT_BATCH_SIZE = process.env.UPSERT_BATCH_SIZE ? Number(process.env.UPSERT_BATCH_SIZE) : 1000;
// bill_uuids per chunk query — bounds the IN list and the rows held at once.
const UUID_BATCH_SIZE = 100;
// bill_uuids per bill-metadata query (small rows, larger batch is fine).
const META_BATCH_SIZE = 1000;

// bill.progress_status (db enum @map labels) that mean the bill can no longer
// advance. Mirrors kafka-service's DEAD_BILL_PROGRESS_STATUSES (the source of truth
// for has_dead_progress_status in the OpenSearch index) — keep these in sync:
// kafka-service/src/consumer/CDCEventConsumer.ts.
const DEAD_PROGRESS_STATUSES = new Set([
  "introduced_crossover_passed", // IntroducedCrossoverPassed
  "introduced_adjournment_passed", // IntroducedAdjournmentPassed
  "failed", // Failed
  "passedfirstchamber_adjournment_passed", // PassedFirstChamberAdjournmentPassed
  "passedsecondchamber_vetoed", // PassedSecondChamberVetoed
]);

// --- Turbopuffer schema ----------------------------------------------------

// Declare `vector` so base64-encoded f32 vectors are unambiguous (see upsert).
const VECTOR_FIELD = { type: `[${EMBEDDING_DIMENSIONS}]f32`, ann: true } as const;

// Single-namespace schema: same attribute set as the per-namespace bill schema,
// plus a filterable `doc_type` so a query can scope to BILL_TEXT / BILL_AMENDMENT
// within the one namespace. Carries ONLY what prod's CandidateRetriever.retrieveBills
// filters on plus the hydration keys (bill_uuid, doc_uuid). Display fields stay in
// Postgres and are rehydrated via bill_uuid — they are not denormalized here.
const BILL_SCHEMA = {
  vector: VECTOR_FIELD,
  // full_text_search enables a BM25 inverted index on the chunk body so we can run
  // keyword/FTS queries (and hybrid vector+BM25) against it. filterable stays off:
  // FTS is its own index — we never need exact equality/`filter` on this big column.
  // english + stemming + stopword removal: match on word stems ("amends" ~ "amend")
  // and drop low-signal terms so BM25 scores on the meaningful tokens.
  content: {
    type: "string",
    filterable: false,
    full_text_search: { language: "english", stemming: true, remove_stopwords: true },
  },
  bill_uuid: { type: "string" },
  doc_uuid: { type: "string" },
  // The doc-type discriminator (BILL_TEXT / BILL_AMENDMENT). filterable so a query
  // can scope to one type within this single namespace.
  doc_type: { type: "string" },
  // int (not uint): Turbopuffer infers signed `int` from integer values, so a uint
  // declaration conflicts with an existing namespace's inferred type. The small
  // positive id values fit either way.
  state_id: { type: "int" },
  status_id: { type: "int" },
  session_id: { type: "int" },
  // committee_id ← bill.pending_directories_committees_id.
  committee_id: { type: "int" },
  current_body_id: { type: "int" },
  // bool flags prod filters on to exclude dead bills.
  is_failed: { type: "bool" },
  is_vetoed: { type: "bool" },
  // derived from progress_status (see DEAD_PROGRESS_STATUSES); mirrors the
  // OpenSearch field kafka-service maintains.
  has_dead_progress_status: { type: "bool" },
  // datetime (not string): Turbopuffer infers `datetime` from the ISO timestamps we
  // send. datetime is natively range-filterable for the notification_action_time range.
  notification_action_time: { type: "datetime" },
} as const;

// --- helpers ---------------------------------------------------------------

/** Format a Postgres date/timestamp (Date | string | null) as a full ISO string. */
function toIsoString(value: unknown): string {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return "";
}

type BillMeta = {
  state_id: number;
  status_id: number;
  session_id: number;
  committee_id: number;
  current_body_id: number;
  is_failed: boolean;
  is_vetoed: boolean;
  has_dead_progress_status: boolean;
  notification_action_time: string;
};

type BillMetaRow = {
  bill_uuid: string;
  state_id: number | null;
  status_id: number | null;
  session_id: number | null;
  current_body_id: number | null;
  pending_directories_committees_id: number | null;
  progress_status: string | null;
  is_failed: boolean | null;
  is_vetoed: boolean | null;
  notification_action_time: Date | string | null;
};

/** Read a done/progress file (one bill_uuid per line). Empty set if absent/unset. */
async function loadSkip(): Promise<Set<string>> {
  if (!SKIP_FILE) return new Set();
  const file = Bun.file(SKIP_FILE);
  if (!(await file.exists())) {
    logger.warn("Skip file not found — ingesting everything", { skipFile: SKIP_FILE });
    return new Set();
  }
  const text = await file.text();
  return new Set(text.split("\n").map((l) => l.trim()).filter(Boolean));
}

/**
 * Select ACTIVE bill_uuids that have at least one chunk of the given doc_type in
 * bill_embedding, optionally bounded by notification_action_time. Ordered for
 * stable, resumable runs.
 */
async function selectBillUuids(docType: string): Promise<string[]> {
  const clauses: Prisma.Sql[] = [
    Prisma.sql`b.is_active = true`,
    Prisma.sql`EXISTS (
      SELECT 1 FROM bill_embedding e
      WHERE e.bill_uuid = b.uuid AND e.doc_type = ${docType}::"BillDocumentType"
    )`,
  ];
  if (START) clauses.push(Prisma.sql`b.notification_action_time >= ${START}::date`);
  // end is inclusive: < end + 1 day, so the whole END day is covered.
  if (END) clauses.push(Prisma.sql`b.notification_action_time < (${END}::date + interval '1 day')`);

  const rows = await prisma.$queryRaw<{ uuid: string }[]>`
    SELECT b.uuid
    FROM bill b
    WHERE ${Prisma.join(clauses, " AND ")}
    ORDER BY b.uuid
  `;

  // Skip + limit applied here (not in SQL) so --limit counts bills actually
  // ingested, after the already-done set is removed.
  const skip = await loadSkip();
  let ids = skip.size ? rows.filter((r) => !skip.has(r.uuid)).map((r) => r.uuid) : rows.map((r) => r.uuid);
  if (skip.size) logger.info("Skipping already-done bills", { skipFile: SKIP_FILE, skipped: skip.size });
  if (LIMIT != null) ids = ids.slice(0, LIMIT);
  return ids;
}

/** Pre-fetch bill-level metadata for the selected uuids into a map. */
async function fetchBillMeta(billUuids: string[]): Promise<Map<string, BillMeta>> {
  const map = new Map<string, BillMeta>();
  for (let i = 0; i < billUuids.length; i += META_BATCH_SIZE) {
    const slice = billUuids.slice(i, i + META_BATCH_SIZE);
    if (slice.length === 0) continue;

    const rows = await prisma.$queryRaw<BillMetaRow[]>`
      SELECT uuid AS bill_uuid, state_id, status_id, session_id, current_body_id,
             pending_directories_committees_id, progress_status::text AS progress_status,
             is_failed, is_vetoed, notification_action_time
      FROM bill
      WHERE uuid IN (${Prisma.join(slice)})
    `;

    for (const r of rows) {
      map.set(r.bill_uuid, {
        state_id: r.state_id ?? 0,
        status_id: r.status_id ?? 0,
        session_id: r.session_id ?? 0,
        current_body_id: r.current_body_id ?? 0,
        // Int? — coalesced to 0 (no null; the FTS schema wants a value).
        committee_id: r.pending_directories_committees_id ?? 0,
        is_failed: r.is_failed ?? false,
        is_vetoed: r.is_vetoed ?? false,
        has_dead_progress_status: r.progress_status ? DEAD_PROGRESS_STATUSES.has(r.progress_status) : false,
        notification_action_time: toIsoString(r.notification_action_time),
      });
    }
    logger.info("Fetched bill metadata", { fetched: map.size, of: billUuids.length });
  }
  return map;
}

// --- main ------------------------------------------------------------------

async function upsertBatch(rows: VectorRow[]): Promise<void> {
  if (rows.length === 0) return;
  // Flat rows: id + base64 f32 vector + metadata at the top level (matching
  // services/turbopuffer/store.ts). base64 vectors are ~2.8x smaller than a JSON
  // number array, which dominates upsert payload size.
  await getTurbopuffer()
    .namespace(NAMESPACE)
    .write({
      upsert_rows: rows.map((r) => ({ id: r.id, vector: encodeVector(r.vector), ...r.metadata })),
      distance_metric: "cosine_distance",
      schema: BILL_SCHEMA,
    });
}

/** Stream + upsert all chunks of one doc_type into the shared namespace. */
async function ingestDocType(collection: CollectionKey): Promise<{ bills: number; chunks: number }> {
  const { docType } = COLLECTIONS[collection];
  logger.info("Selecting bills", {
    collection,
    docType,
    namespace: NAMESPACE,
    start: START ?? "(none)",
    end: END ?? "(none)",
    limit: LIMIT ?? "all",
  });

  const billUuids = await selectBillUuids(docType);
  logger.info("Matched bills", { collection, bills: billUuids.length });

  if (DRY_RUN) {
    for (const id of billUuids) console.log(id);
    return { bills: billUuids.length, chunks: 0 };
  }

  if (billUuids.length === 0) {
    logger.info("Nothing to ingest", { collection });
    return { bills: 0, chunks: 0 };
  }

  const meta = await fetchBillMeta(billUuids);

  const bar = new ProgressBar(collection, {});
  const buffer: VectorRow[] = [];
  let upserted = 0;
  let missingMeta = 0;

  const flush = async () => {
    if (buffer.length === 0) return;
    await upsertBatch(buffer);
    upserted += buffer.length;
    bar.tick(buffer.length);
    buffer.length = 0;
  };

  for await (const batch of streamChunksForBills(docType, billUuids, { uuidBatchSize: UUID_BATCH_SIZE })) {
    for (const c of batch) {
      const m = meta.get(c.bill_uuid);
      if (!m) missingMeta++;
      const metadata: Record<string, MetadataValue> = {
        bill_uuid: c.bill_uuid,
        doc_uuid: c.doc_uuid,
        doc_type: docType,
        chunk_id: c.chunk_id,
        content: c.content,
        state_id: m?.state_id ?? 0,
        status_id: m?.status_id ?? 0,
        session_id: m?.session_id ?? 0,
        committee_id: m?.committee_id ?? 0,
        current_body_id: m?.current_body_id ?? 0,
        is_failed: m?.is_failed ?? false,
        is_vetoed: m?.is_vetoed ?? false,
        has_dead_progress_status: m?.has_dead_progress_status ?? false,
        notification_action_time: m?.notification_action_time ?? "",
      };
      buffer.push({ id: `${c.doc_uuid}::${c.chunk_id}`, vector: c.embedding, metadata });
      if (buffer.length >= UPSERT_BATCH_SIZE) await flush();
    }
  }
  await flush();
  bar.done();

  logger.info("Doc type complete", { collection, namespace: NAMESPACE, bills: billUuids.length, chunks: upserted, missingMeta });
  return { bills: billUuids.length, chunks: upserted };
}

async function main() {
  // Single namespace: reset ONCE up front, not per doc type (else the second doc
  // type's reset would wipe the first type's rows).
  if (RESET && !DRY_RUN) {
    try {
      await getTurbopuffer().namespace(NAMESPACE).deleteAll();
      logger.info("Reset namespace", { namespace: NAMESPACE });
    } catch (error: any) {
      if (error?.status !== 404) throw error;
      logger.info("Reset skipped (namespace does not exist)", { namespace: NAMESPACE });
    }
  }

  const wallStart = performance.now();
  let totalBills = 0;
  let totalChunks = 0;
  for (const collection of COLLECTIONS_TO_INGEST) {
    const { bills, chunks } = await ingestDocType(collection);
    totalBills += bills;
    totalChunks += chunks;
  }

  const wallMs = performance.now() - wallStart;
  logger.info("Ingest complete", {
    namespace: NAMESPACE,
    docTypes: COLLECTIONS_TO_INGEST,
    bills: totalBills,
    chunks: totalChunks,
    wallSeconds: Number((wallMs / 1000).toFixed(1)),
    chunksPerSec: Math.round(totalChunks / (wallMs / 1000 || 1)),
  });

  await prisma.$disconnect();
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
