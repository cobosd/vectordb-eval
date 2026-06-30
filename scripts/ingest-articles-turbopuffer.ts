/**
 * Backfill article chunk embeddings into a Turbopuffer namespace.
 *
 * This repo already has precomputed article chunks + 1536-dim embeddings in
 * Postgres (`article_embedding`). So this script just *reads* those chunks, joins
 * article-level metadata (from `article`), and upserts one Turbopuffer row per
 * chunk. Turbopuffer is the only sink.
 *
 * Row id is `${article_id}::${chunk_id}` (matching the bill/hearing ingest
 * convention), so re-runs are idempotent — a chunk overwrites its own row rather
 * than duplicating.
 *
 * Usage:
 *   bun scripts/ingest-articles-turbopuffer.ts                       # all articles
 *   bun scripts/ingest-articles-turbopuffer.ts --skip-file=PATH      # skip an article_id list
 *   bun scripts/ingest-articles-turbopuffer.ts --namespace=article   # target ns (default: article)
 *   bun scripts/ingest-articles-turbopuffer.ts --start=2025-01-01 --end=2025-01-31
 *   bun scripts/ingest-articles-turbopuffer.ts --limit=100           # at most N articles
 *   bun scripts/ingest-articles-turbopuffer.ts --reset               # wipe namespace first
 *   bun scripts/ingest-articles-turbopuffer.ts --dry-run             # print article_ids and exit
 *
 * Needs DB_URL + TURBOPUFFER_API_KEY in .env (auto-loaded by Bun).
 */

import { Prisma } from "@prisma/client";
import { prisma } from "../prisma/client";
import { EMBEDDING_DIMENSIONS } from "../consts";
import { getTurbopuffer } from "../services/turbopuffer/client";
import { encodeVector } from "../utils/vector-cache";
import { createWritePool } from "../utils/write-pool";
import { ProgressBar } from "../utils/progress";
import type { MetadataValue, VectorRow } from "../utils/vector-store";
import { createLogger } from "../logger";

const logger = createLogger("ingest-articles-turbopuffer");

// --- flags -----------------------------------------------------------------

const flag = (name: string, fallback?: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;

const NAMESPACE = flag("namespace", "article")!;
const START = flag("start"); // inclusive YYYY-MM-DD, filters article.post_date
const END = flag("end"); // inclusive YYYY-MM-DD
const LIMIT = flag("limit") ? Number(flag("limit")) : null; // cap on # of articles
// Optional progress/done file (one article_id per line) whose articles are skipped,
// so an already-ingested set isn't re-upserted. No default — a plain run ingests
// everything. Pass --skip-file=PATH to resume against a prior run.
const SKIP_FILE = flag("skip-file") || undefined;
const RESET = process.argv.includes("--reset");
const DRY_RUN = process.argv.includes("--dry-run");
// Rows per Turbopuffer write(). Batch SIZE barely affects throughput above ~1k
// (measured); what matters is how many writes are in flight (WRITE_CONCURRENCY).
// 2000 keeps each request small while leaving several batches in flight. Override to sweep.
const UPSERT_BATCH_SIZE = process.env.UPSERT_BATCH_SIZE ? Number(process.env.UPSERT_BATCH_SIZE) : 2000;
// Concurrent TP writes to the namespace. TP caps single-namespace write throughput
// (~230 rows/s); 1 in-flight write only reaches ~half that, ~4 concurrent saturates
// it (8+ shows no further gain). Override to tune.
const WRITE_CONCURRENCY = process.env.WRITE_CONCURRENCY ? Number(process.env.WRITE_CONCURRENCY) : 4;
// article_ids per chunk query — bounds the IN list and the rows held at once.
const ENTITY_BATCH_SIZE = 100;
// article_ids per article-metadata query (small rows, larger batch is fine).
const META_BATCH_SIZE = 1000;

// --- Turbopuffer schema ----------------------------------------------------

// Declare `vector` so base64-encoded f32 vectors are unambiguous (see upsert).
const VECTOR_FIELD = { type: `[${EMBEDDING_DIMENSIONS}]f32`, ann: true } as const;

// Per the v0 namespace mapping, the `article` namespace carries ONLY what prod's
// CandidateRetriever.retrieveArticles needs: the filter predicates (`article.state_ids`
// array overlap, `article.post_date` range, `article.sections` for content-type) plus
// `article_id` as the hydration key. Display fields (title, excerpt, url, etc.) stay
// in Postgres and are rehydrated via article_id — they are not denormalized here.
const ARTICLE_SCHEMA = {
  vector: VECTOR_FIELD,
  // full_text_search enables a BM25 inverted index on the chunk body so we can run
  // keyword/FTS queries (and hybrid vector+BM25) against it. filterable stays off:
  // FTS is its own index — we never need exact equality/`filter` on this big column.
  // english + stemming + stopword removal: match on word stems ("hearings" ~ "hearing")
  // and drop low-signal terms so BM25 scores on the meaningful tokens.
  content: {
    type: "string",
    filterable: false,
    full_text_search: { language: "english", stemming: true, remove_stopwords: true },
  },
  // int (not uint): Turbopuffer infers signed `int` from integer values, so a uint
  // declaration conflicts with an existing namespace's inferred type. The small
  // positive id values fit either way.
  article_id: { type: "int" },
  // []int array: prod filters states with an overlap predicate, so this is an array
  // attribute. Turbopuffer indexes it for Contains/In filtering.
  state_ids: { type: "[]int" },
  // []string array: content-type is derived from whether a press-release section is
  // present, so the raw sections list is filtered with Contains at query time.
  sections: { type: "[]string" },
  // datetime (not string): Turbopuffer infers `datetime` from the ISO timestamps we
  // send. datetime is natively range-filterable for the post_date range predicate.
  post_date: { type: "datetime" },
} as const;

// --- helpers ---------------------------------------------------------------

/** Format a Postgres date/timestamp (Date | string | null) as a full ISO string. */
function toIsoString(value: unknown): string {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return "";
}

type ArticleMeta = {
  state_ids: number[];
  sections: string[];
  post_date: string;
};

type ArticleMetaRow = {
  id: number;
  state_ids: number[] | null;
  sections: string[] | null;
  post_date: Date | string | null;
};

/** Read a done/progress file (one article_id per line). Empty set if absent/unset. */
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
 * Select article ids in the (optional) date range, restricted to articles that
 * actually have at least one chunk in article_embedding. Ordered for stable,
 * resumable runs.
 */
async function selectArticleIds(): Promise<number[]> {
  // Always at least the EXISTS predicate; date bounds are ANDed in when given.
  const clauses: Prisma.Sql[] = [
    Prisma.sql`EXISTS (SELECT 1 FROM article_embedding e WHERE e.article_id = a.id)`,
  ];
  if (START) clauses.push(Prisma.sql`a.post_date >= ${START}::date`);
  // end is inclusive: < end + 1 day, so the whole END day is covered.
  if (END) clauses.push(Prisma.sql`a.post_date < (${END}::date + interval '1 day')`);

  const rows = await prisma.$queryRaw<{ id: number }[]>`
    SELECT a.id
    FROM article a
    WHERE ${Prisma.join(clauses, " AND ")}
    ORDER BY a.id
  `;

  // Skip + limit applied here (not in SQL) so --limit counts articles actually
  // ingested, after the already-done set is removed.
  const skip = await loadSkip();
  let ids = skip.size ? rows.filter((r) => !skip.has(String(r.id))).map((r) => r.id) : rows.map((r) => r.id);
  if (skip.size) logger.info("Skipping already-done articles", { skipFile: SKIP_FILE, skipped: skip.size });
  if (LIMIT != null) ids = ids.slice(0, LIMIT);
  return ids;
}

/** Pre-fetch article-level metadata for the selected ids into a map. */
async function fetchArticleMeta(articleIds: number[]): Promise<Map<number, ArticleMeta>> {
  const map = new Map<number, ArticleMeta>();
  for (let i = 0; i < articleIds.length; i += META_BATCH_SIZE) {
    const slice = articleIds.slice(i, i + META_BATCH_SIZE);
    if (slice.length === 0) continue;

    const rows = await prisma.$queryRaw<ArticleMetaRow[]>`
      SELECT id, state_ids, sections, post_date
      FROM article
      WHERE id IN (${Prisma.join(slice)})
    `;

    for (const r of rows) {
      map.set(r.id, {
        state_ids: r.state_ids ?? [],
        sections: r.sections ?? [],
        post_date: toIsoString(r.post_date),
      });
    }
    logger.info("Fetched article metadata", { fetched: map.size, of: articleIds.length });
  }
  return map;
}

// embedding as number[] directly: selecting `embedding::real[]` (not `::text`) lets
// Prisma deserialize the pgvector into a number[] in the query engine, skipping the
// per-row "[..]"->split->Number(x1536) JS parse that dominated read CPU (~2.8x faster).
type ChunkRow = { article_id: number; chunk_id: number; content: string; embedding: number[] };

/**
 * Stream chunks for a set of article_ids in batches of ids (so the IN list and the
 * result set stay bounded). Yields one batch of assembled chunks per id group.
 */
async function* streamChunksForArticles(articleIds: number[]): AsyncGenerator<ChunkRow[]> {
  for (let i = 0; i < articleIds.length; i += ENTITY_BATCH_SIZE) {
    const slice = articleIds.slice(i, i + ENTITY_BATCH_SIZE);
    if (slice.length === 0) continue;

    const rows = await prisma.$queryRaw<ChunkRow[]>`
      SELECT article_id, chunk_id, content, embedding::real[] AS embedding
      FROM article_embedding
      WHERE article_id IN (${Prisma.join(slice)})
      ORDER BY article_id, chunk_id
    `;

    if (rows.length) yield rows;
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
      schema: ARTICLE_SCHEMA,
    });
}

async function main() {
  logger.info("Selecting articles", {
    namespace: NAMESPACE,
    start: START ?? "(none)",
    end: END ?? "(none)",
    limit: LIMIT ?? "all",
  });

  const articleIds = await selectArticleIds();
  logger.info("Matched articles", { articles: articleIds.length });

  if (DRY_RUN) {
    for (const id of articleIds) console.log(id);
    await prisma.$disconnect();
    return;
  }

  if (articleIds.length === 0) {
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

  const meta = await fetchArticleMeta(articleIds);

  const bar = new ProgressBar("article", {});
  let buffer: VectorRow[] = [];
  let upserted = 0;
  let missingMeta = 0;
  const wallStart = performance.now();

  // Keep up to WRITE_CONCURRENCY writes in flight while the next batches are read +
  // vector-parsed, so Postgres/CPU overlaps the network round-trips and several
  // writes saturate TP's per-namespace write throughput.
  const pool = createWritePool(WRITE_CONCURRENCY);
  const flush = async () => {
    if (buffer.length === 0) return;
    const batch = buffer;
    buffer = [];
    await pool.submit(() =>
      upsertBatch(batch).then(() => {
        upserted += batch.length;
        bar.tick(batch.length);
      }),
    );
  };

  for await (const batch of streamChunksForArticles(articleIds)) {
    for (const c of batch) {
      const m = meta.get(c.article_id);
      if (!m) missingMeta++;
      const metadata: Record<string, MetadataValue> = {
        article_id: c.article_id,
        chunk_id: c.chunk_id,
        content: c.content,
        state_ids: m?.state_ids ?? [],
        sections: m?.sections ?? [],
      };
      // post_date is a TP `datetime` — an empty string fails to parse and rejects
      // the whole write, so only set it when present.
      if (m?.post_date) metadata.post_date = m.post_date;
      buffer.push({ id: `${c.article_id}::${c.chunk_id}`, vector: c.embedding, metadata });
      if (buffer.length >= UPSERT_BATCH_SIZE) await flush();
    }
  }
  await flush();
  await pool.drain(); // drain outstanding writes
  bar.done();

  const wallMs = performance.now() - wallStart;
  logger.info("Ingest complete", {
    namespace: NAMESPACE,
    articles: articleIds.length,
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
