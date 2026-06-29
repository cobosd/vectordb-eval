/**
 * Backfill hearing chunk embeddings into a Turbopuffer namespace.
 *
 * Unlike datacore's `backfill_hearings_turbopuffer.py` — which chunks + embeds
 * transcripts on the fly with OpenAI — this repo already has precomputed hearing
 * chunks + 1536-dim embeddings in Postgres (`hearing_embedding`). So this script
 * just *reads* those chunks, joins hearing-level metadata (from `hearing`), and
 * upserts one Turbopuffer row per chunk. Turbopuffer is the only sink.
 *
 * Row id is `${entity_id}::${chunk_id}` (matching the bill ingest convention), so
 * re-runs are idempotent — a chunk overwrites its own row rather than duplicating.
 *
 * Usage:
 *   bun scripts/ingest-hearings-turbopuffer.ts                       # all hearings
 *   bun scripts/ingest-hearings-turbopuffer.ts --namespace=hearing   # target ns (default: hearing)
 *   bun scripts/ingest-hearings-turbopuffer.ts --start=2025-01-01 --end=2025-01-31
 *   bun scripts/ingest-hearings-turbopuffer.ts --limit=100           # at most N hearings
 *   bun scripts/ingest-hearings-turbopuffer.ts --reset               # wipe namespace first
 *   bun scripts/ingest-hearings-turbopuffer.ts --dry-run             # print entity_ids and exit
 *
 * Needs DB_URL + TURBOPUFFER_API_KEY in .env (auto-loaded by Bun).
 */

import { Prisma } from "@prisma/client";
import { prisma } from "../prisma/client";
import { EMBEDDING_DIMENSIONS } from "../consts";
import { getTurbopuffer } from "../services/turbopuffer/client";
import { encodeVector } from "../utils/vector-cache";
import { toEpoch } from "../utils/bill-metadata";
import { ProgressBar } from "../utils/progress";
import type { MetadataValue, VectorRow } from "../utils/vector-store";
import { createLogger } from "../logger";

const logger = createLogger("ingest-hearings-turbopuffer");

// --- flags -----------------------------------------------------------------

const flag = (name: string, fallback?: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;

const NAMESPACE = flag("namespace", "hearing")!;
const START = flag("start"); // inclusive YYYY-MM-DD, filters hearing.event_date
const END = flag("end"); // inclusive YYYY-MM-DD
const LIMIT = flag("limit") ? Number(flag("limit")) : null; // cap on # of hearings
const RESET = process.argv.includes("--reset");
const DRY_RUN = process.argv.includes("--dry-run");
// Rows per Turbopuffer write(). Turbopuffer sends the whole buffer in one request
// (512MB / no row cap); 1000 keeps each write comfortably sized. Override to sweep.
const UPSERT_BATCH_SIZE = process.env.UPSERT_BATCH_SIZE ? Number(process.env.UPSERT_BATCH_SIZE) : 1000;
// entity_ids per chunk query — bounds the IN list and the rows held at once.
const ENTITY_BATCH_SIZE = 100;
// entity_ids per hearing-metadata query (small rows, larger batch is fine).
const META_BATCH_SIZE = 1000;

// --- Turbopuffer schema ----------------------------------------------------

// Declare `vector` so base64-encoded f32 vectors are unambiguous (see upsert).
const VECTOR_FIELD = { type: `[${EMBEDDING_DIMENSIONS}]f32`, ann: true } as const;

// Mirror the bill schema philosophy (services/turbopuffer/store.ts): declare the
// selective filter predicates with a real numeric/string type + index, and mark the
// big text/url columns filterable:false so Turbopuffer skips useless attribute
// indexes (and gets the storage discount). state_id is the selective equality
// predicate; event_date_epoch is the range predicate.
const HEARING_SCHEMA = {
  vector: VECTOR_FIELD,
  chunk_text: { type: "string", filterable: false },
  title: { type: "string", filterable: false },
  summary: { type: "string", filterable: false },
  entity_id: { type: "string" },
  state_id: { type: "uint" },
  session_id: { type: "int" },
  event_date_epoch: { type: "int" },
  event_date: { type: "string", filterable: false },
  chamber: { type: "string" },
  hearing_type: { type: "string" },
  committee: { type: "string", filterable: false },
  location: { type: "string", filterable: false },
  source_url: { type: "string", filterable: false },
} as const;

// --- helpers ---------------------------------------------------------------

/** Format a Postgres date/timestamp (Date | string | null) as a full ISO string. */
function toIsoString(value: unknown): string {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return "";
}

/** pgvector text format "[0.1,0.2,...]" → number[]. */
function parseVector(text: string): number[] {
  return text
    .slice(1, -1)
    .split(",")
    .map((n) => Number(n));
}

type HearingMeta = {
  title: string;
  state_id: number;
  session_id: number;
  event_date: string;
  event_date_epoch: number;
  chamber: string;
  committee: string;
  location: string;
  source_url: string;
  hearing_type: string;
  summary: string;
};

type HearingMetaRow = {
  entity_id: string;
  title: string | null;
  state_id: number | null;
  session_id: number | null;
  event_date: Date | string | null;
  chamber: string | null;
  committee: string | null;
  location: string | null;
  source_url: string | null;
  hearing_type: string | null;
  summary: string | null;
};

/**
 * Select hearing entity_ids in the (optional) date range, restricted to hearings
 * that actually have at least one chunk in hearing_embedding. Ordered for stable,
 * resumable runs.
 */
async function selectEntityIds(): Promise<string[]> {
  // Always at least the EXISTS predicate; date bounds are ANDed in when given.
  const clauses: Prisma.Sql[] = [
    Prisma.sql`EXISTS (SELECT 1 FROM hearing_embedding e WHERE e.entity_id = h.entity_id)`,
  ];
  if (START) clauses.push(Prisma.sql`h.event_date >= ${START}::date`);
  // end is inclusive: < end + 1 day, so the whole END day is covered.
  if (END) clauses.push(Prisma.sql`h.event_date < (${END}::date + interval '1 day')`);
  const limitClause = LIMIT != null ? Prisma.sql`LIMIT ${LIMIT}` : Prisma.empty;

  const rows = await prisma.$queryRaw<{ entity_id: string }[]>`
    SELECT h.entity_id
    FROM hearing h
    WHERE ${Prisma.join(clauses, " AND ")}
    ORDER BY h.entity_id
    ${limitClause}
  `;
  return rows.map((r) => r.entity_id);
}

/** Pre-fetch hearing-level metadata for the selected entity_ids into a map. */
async function fetchHearingMeta(entityIds: string[]): Promise<Map<string, HearingMeta>> {
  const map = new Map<string, HearingMeta>();
  for (let i = 0; i < entityIds.length; i += META_BATCH_SIZE) {
    const slice = entityIds.slice(i, i + META_BATCH_SIZE);
    if (slice.length === 0) continue;

    const rows = await prisma.$queryRaw<HearingMetaRow[]>`
      SELECT entity_id, title, state_id, session_id, event_date, chamber, committee,
             location, source_url, hearing_type::text AS hearing_type, summary
      FROM hearing
      WHERE entity_id IN (${Prisma.join(slice)})
    `;

    for (const r of rows) {
      const eventDate = toIsoString(r.event_date);
      map.set(r.entity_id, {
        title: r.title ?? "",
        state_id: r.state_id ?? 0,
        session_id: r.session_id ?? 0,
        event_date: eventDate,
        // Numeric epoch (ms) so backends range-filter on a real number, not a string.
        event_date_epoch: toEpoch(eventDate),
        chamber: r.chamber ?? "",
        committee: r.committee ?? "",
        location: r.location ?? "",
        source_url: r.source_url ?? "",
        hearing_type: r.hearing_type ?? "",
        summary: r.summary ?? "",
      });
    }
    logger.info("Fetched hearing metadata", { fetched: map.size, of: entityIds.length });
  }
  return map;
}

type ChunkRow = { entity_id: string; chunk_id: number; content: string; embedding: string };

/**
 * Stream chunks for a set of entity_ids in batches of ids (so the IN list and the
 * result set stay bounded). Yields one batch of assembled chunks per id group.
 */
async function* streamChunksForHearings(
  entityIds: string[],
): AsyncGenerator<{ entity_id: string; chunk_id: number; content: string; embedding: number[] }[]> {
  for (let i = 0; i < entityIds.length; i += ENTITY_BATCH_SIZE) {
    const slice = entityIds.slice(i, i + ENTITY_BATCH_SIZE);
    if (slice.length === 0) continue;

    const rows = await prisma.$queryRaw<ChunkRow[]>`
      SELECT entity_id, chunk_id, content, embedding::text AS embedding
      FROM hearing_embedding
      WHERE entity_id IN (${Prisma.join(slice)})
      ORDER BY entity_id, chunk_id
    `;

    if (rows.length) yield rows.map((r) => ({ ...r, embedding: parseVector(r.embedding) }));
  }
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
      schema: HEARING_SCHEMA,
    });
}

async function main() {
  logger.info("Selecting hearings", {
    namespace: NAMESPACE,
    start: START ?? "(none)",
    end: END ?? "(none)",
    limit: LIMIT ?? "all",
  });

  const entityIds = await selectEntityIds();
  logger.info("Matched hearings", { hearings: entityIds.length });

  if (DRY_RUN) {
    for (const id of entityIds) console.log(id);
    await prisma.$disconnect();
    return;
  }

  if (entityIds.length === 0) {
    logger.info("Nothing to ingest");
    await prisma.$disconnect();
    return;
  }

  if (RESET) {
    try {
      await getTurbopuffer().namespace(NAMESPACE).deleteAll();
      logger.info("Reset namespace", { namespace: NAMESPACE });
    } catch (error: any) {
      if (error?.status !== 404) throw error;
      logger.info("Reset skipped (namespace does not exist)", { namespace: NAMESPACE });
    }
  }

  const meta = await fetchHearingMeta(entityIds);

  const bar = new ProgressBar("hearing", {});
  const buffer: VectorRow[] = [];
  let upserted = 0;
  let missingMeta = 0;
  const wallStart = performance.now();

  const flush = async () => {
    if (buffer.length === 0) return;
    await upsertBatch(buffer);
    upserted += buffer.length;
    bar.tick(buffer.length);
    buffer.length = 0;
  };

  for await (const batch of streamChunksForHearings(entityIds)) {
    for (const c of batch) {
      const m = meta.get(c.entity_id);
      if (!m) missingMeta++;
      const metadata: Record<string, MetadataValue> = {
        entity_id: c.entity_id,
        chunk_id: c.chunk_id,
        chunk_text: c.content,
        title: m?.title ?? "",
        state_id: m?.state_id ?? 0,
        session_id: m?.session_id ?? 0,
        event_date: m?.event_date ?? "",
        event_date_epoch: m?.event_date_epoch ?? 0,
        chamber: m?.chamber ?? "",
        committee: m?.committee ?? "",
        location: m?.location ?? "",
        source_url: m?.source_url ?? "",
        hearing_type: m?.hearing_type ?? "",
        summary: m?.summary ?? "",
      };
      buffer.push({ id: `${c.entity_id}::${c.chunk_id}`, vector: c.embedding, metadata });
      if (buffer.length >= UPSERT_BATCH_SIZE) await flush();
    }
  }
  await flush();
  bar.done();

  const wallMs = performance.now() - wallStart;
  logger.info("Ingest complete", {
    namespace: NAMESPACE,
    hearings: entityIds.length,
    chunks: upserted,
    missingMeta,
    wallSeconds: Number((wallMs / 1000).toFixed(1)),
    chunksPerSec: Math.round(upserted / (wallMs / 1000 || 1)),
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
