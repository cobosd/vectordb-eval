/**
 * Turbopuffer-backed VectorStore: one namespace per collection. Defines the
 * per-collection (vector-only) schema, lazily-created namespaces, upserts,
 * eventually-consistent vector queries, a `warm()` cache prewarm, and a
 * `sample()` helper for eyeballing stored rows.
 */

import type { CollectionKey } from "../../consts";
import { COLLECTIONS, EMBEDDING_DIMENSIONS } from "../../consts";
import type {
  FilterOp,
  MetadataValue,
  QueryFilter,
  QueryHit,
  QueryOptions,
  VectorRow,
  VectorStore,
} from "../../utils/vector-store";
import { createLogger } from "../../logger";
import { encodeVector } from "../../utils/vector-cache";
import { getTurbopuffer } from "./client";

const logger = createLogger("turbopuffer");

// TPUF_DEBUG=1 logs the wall time of each write() (includes any SDK retry/back-off),
// to compare against the per-HTTP-attempt latency logged in client.ts.
const TPUF_DEBUG = process.env.TPUF_DEBUG === "1";

const DISTANCE_METRIC = "cosine_distance" as const;
// Reserved row keys that aren't user metadata attributes.
const RESERVED_ROW_KEYS = new Set(["id", "vector", "$dist"]);

// Normalized filter op → Turbopuffer operator.
const TP_OPS: Record<FilterOp, string> = {
  eq: "Eq",
  gt: "Gt",
  gte: "Gte",
  lt: "Lt",
  lte: "Lte",
  in: "In",
};

/** Translate a normalized filter into Turbopuffer's tuple syntax (conditions ANDed). */
function toTurbopufferFilter(filter: QueryFilter): unknown {
  const clauses = filter.map((c) => [c.field, TP_OPS[c.op], c.value]);
  return clauses.length === 1 ? clauses[0] : ["And", clauses];
}

// Declare the vector column explicitly so base64-encoded vectors (see upsert) are
// unambiguous: the dimension + f32 element type are stated rather than inferred from
// the wire bytes. `vector` is the conventional name Turbopuffer auto-ANN-indexes.
const VECTOR_FIELD = { type: `[${EMBEDDING_DIMENSIONS}]f32`, ann: true } as const;

// Vector-only namespaces: no BM25/full-text-search indexes (queries are pure ANN,
// so FTS would just cost ingest time + storage).
//
// Every attribute written by buildBillMetadata is declared explicitly rather than
// left to Turbopuffer's type inference, for two reasons:
//   1. The fields we actually filter on (session_id, notification_action_time_epoch)
//      get a guaranteed numeric type + attribute index — a range filter on an
//      inferred-string epoch would be both wrong and slow.
//   2. Fields we never filter (large text, urls, flags, the human-readable date)
//      are marked filterable:false so Turbopuffer skips building useless attribute
//      indexes (also a ~50% storage discount on the big string columns).
// session_id is the selective equality predicate; the epoch is the range predicate.
const SCHEMA_TEXT = {
  vector: VECTOR_FIELD,
  chunk_text: { type: "string", filterable: false },
  summary: { type: "string", filterable: false },
  bill_number_normalized: { type: "string" },
  session_id: { type: "uint" },
  notification_action_time_epoch: { type: "int" },
  notification_action_time: { type: "string", filterable: false },
  has_dead_progress_status: { type: "bool", filterable: false },
  is_active: { type: "bool", filterable: false },
  hide: { type: "bool", filterable: false },
  s3_url: { type: "string", filterable: false },
  bill_text_date: { type: "string", filterable: false },
} as const;
const SCHEMA_AMENDMENT = {
  vector: VECTOR_FIELD,
  chunk_text: { type: "string", filterable: false },
  summary: { type: "string", filterable: false },
  bill_number_normalized: { type: "string" },
  session_id: { type: "uint" },
  notification_action_time_epoch: { type: "int" },
  notification_action_time: { type: "string", filterable: false },
  has_dead_progress_status: { type: "bool", filterable: false },
  is_active: { type: "bool", filterable: false },
  hide: { type: "bool", filterable: false },
  s3_url: { type: "string", filterable: false },
  amendment_date: { type: "string", filterable: false },
} as const;

/** Per-collection Turbopuffer schema (namespace name comes from consts). */
export const TURBOPUFFER_SCHEMAS = {
  bill_text: SCHEMA_TEXT,
  bill_amendment: SCHEMA_AMENDMENT,
} as const;

/** Turbopuffer-backed store for one collection (namespace). */
export class TurbopufferStore implements VectorStore {
  readonly service = "turbopuffer" as const;
  private readonly namespace: string;
  // Undefined for the single-namespace `bill` collection: it's a query-only
  // benchmark target here; its writes go through ingest-bills-sn-turbopuffer.ts.
  private readonly schema: (typeof TURBOPUFFER_SCHEMAS)[keyof typeof TURBOPUFFER_SCHEMAS] | undefined;

  constructor(collection: CollectionKey) {
    this.namespace = COLLECTIONS[collection].turbopufferNamespace;
    this.schema = (TURBOPUFFER_SCHEMAS as Record<string, typeof SCHEMA_TEXT | typeof SCHEMA_AMENDMENT>)[collection];
  }

  private ns() {
    return getTurbopuffer().namespace(this.namespace);
  }

  /** Turbopuffer namespaces are created lazily on first write — nothing to do. */
  async ensure(): Promise<void> {}

  async reset(): Promise<void> {
    try {
      await this.ns().deleteAll();
      logger.info("Reset namespace", { namespace: this.namespace });
    } catch (error: any) {
      if (error?.status === 404) {
        logger.info("Reset skipped (namespace does not exist)", { namespace: this.namespace });
      } else {
        throw error;
      }
    }
  }

  async upsert(rows: VectorRow[]): Promise<void> {
    if (rows.length === 0) return;
    if (!this.schema) {
      throw new Error(
        `No Turbopuffer schema for namespace "${this.namespace}" — this collection is query-only here; ` +
          `ingest it via ingest-bills-sn-turbopuffer.ts`,
      );
    }
    const start = TPUF_DEBUG ? Date.now() : 0;
    // Turbopuffer rows are flat: id + vector + metadata attributes at the top level.
    // Vectors go over the wire as base64 little-endian f32 (~8KB) rather than a JSON
    // number array (~23KB) — the API accepts both and base64 is ~2.8x smaller, which
    // dominates upsert payload size (and thus throughput when bandwidth-bound).
    await this.ns().write({
      upsert_rows: rows.map((r) => ({ id: r.id, vector: encodeVector(r.vector), ...r.metadata })),
      distance_metric: DISTANCE_METRIC,
      schema: this.schema,
    });
    if (TPUF_DEBUG) {
      const ms = Date.now() - start;
      process.stderr.write(
        `[tpuf] write ${this.namespace} ${rows.length} rows -> ${ms}ms total (${Math.round(rows.length / (ms / 1000 || 1))}/s)\n`
      );
    }
  }

  /** Turbopuffer rows are flat — lift the non-reserved attributes into metadata. */
  private static toMetadata(row: Record<string, unknown>): Record<string, MetadataValue> {
    const metadata: Record<string, MetadataValue> = {};
    for (const [key, value] of Object.entries(row)) {
      if (!RESERVED_ROW_KEYS.has(key)) metadata[key] = value as MetadataValue;
    }
    return metadata;
  }

  async query(vector: number[], options: QueryOptions = {}): Promise<QueryHit[]> {
    const { topK = 10, consistency = "eventual", filter, minimal, onPerf } = options;
    const result = await this.ns().query({
      rank_by: ["vector", "ANN", vector],
      limit: topK,
      // minimal: return nothing but id + $dist. Otherwise all metadata EXCEPT the
      // raw vector — exclude "vector" rather than include_attributes:true, since
      // true also returns the 1536-dim vector per hit (~20KB/row) and dominates
      // the response payload.
      ...(minimal ? { include_attributes: false } : { exclude_attributes: ["vector"] }),
      // Eventual by default: skips strong consistency's object-storage round-trip
      // and matches Pinecone serverless (also eventual).
      consistency: { level: consistency },
      ...(filter ? { filters: toTurbopufferFilter(filter) as never } : {}),
    });
    // Surface the server-side diagnostics so callers can tell cache warmth and
    // exhaustive (unindexed) scanning apart from genuine filter/search cost.
    if (onPerf) {
      const perf = (result as { performance?: Record<string, unknown> }).performance;
      const n = (v: unknown) => (typeof v === "number" ? v : undefined);
      const s = (v: unknown) => (typeof v === "string" ? v : undefined);
      if (perf) {
        onPerf({
          cacheTemperature: s(perf.cache_temperature),
          cacheHitRatio: n(perf.cache_hit_ratio),
          serverTotalMs: n(perf.server_total_ms),
          queryExecutionMs: n(perf.query_execution_ms),
          exhaustiveSearchCount: n(perf.exhaustive_search_count),
          approxNamespaceSize: n(perf.approx_namespace_size),
          lastIncludedWriteAt: s(perf.last_included_write_at),
        });
      }
    }
    return (result.rows ?? []).map((row) => ({
      id: String(row.id),
      // cosine_distance → cosine similarity, so it matches Pinecone's scoring.
      score: typeof row.$dist === "number" ? 1 - row.$dist : 0,
      metadata: TurbopufferStore.toMetadata(row),
    }));
  }

  /** Prewarm the namespace cache to avoid cold-start latency (cold p50 ~874ms vs warm ~14ms). */
  async warm(): Promise<void> {
    await this.ns().hintCacheWarm();
  }

  /**
   * Pull an arbitrary sample of rows by running an ANN query against a constant
   * vector. Handy for eyeballing what's stored in a namespace. Returns `[]` if
   * the namespace doesn't exist yet.
   */
  async sample(size = 5): Promise<QueryHit[]> {
    try {
      return await this.query(Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.1), {
        topK: size,
      });
    } catch (error: any) {
      if (error?.status === 404) {
        logger.warn("Namespace does not exist", { namespace: this.namespace });
        return [];
      }
      throw error;
    }
  }
}
