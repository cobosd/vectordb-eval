/**
 * Qdrant-backed VectorStore: one collection per logical collection. Handles
 * collection creation/reset, batched upserts, and nearest-neighbor queries with
 * payload filtering.
 *
 * Two Qdrant-specific wrinkles vs Turbopuffer/Pinecone:
 *  1. Point IDs must be unsigned ints or UUIDs — our IDs are composite strings
 *     ("doc_uuid::chunk_id"), so we map each to a deterministic UUIDv5 and keep
 *     the original under the `__row_id` payload key to return verbatim.
 *  2. Filtering wants payload indexes to be fast, so `ensure()` creates integer
 *     indexes on the fields the filtered benchmark queries (session_id, epoch).
 */

import { createHash } from "node:crypto";
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
import { getQdrant } from "./client";

const logger = createLogger("qdrant");

const DISTANCE_METRIC = "Cosine" as const;
// Payload key holding the original composite row id (Qdrant point ids are UUIDs).
const ROW_ID_KEY = "__row_id";
// Qdrant accepts large upserts, but keep request bodies bounded.
const UPSERT_BATCH = 500;
// Integer payload fields the filtered benchmark queries — indexed for fast filtering.
const INDEXED_INT_FIELDS = ["session_id", "notification_action_time_epoch"] as const;

// Fixed namespace for deterministic UUIDv5 row-id mapping (any constant UUID works).
const ID_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

/** Deterministic UUIDv5 of a string — stable across runs, so re-upserts overwrite. */
function toPointId(rowId: string): string {
  const nsBytes = Buffer.from(ID_NAMESPACE.replace(/-/g, ""), "hex");
  const hash = createHash("sha1")
    .update(nsBytes)
    .update(Buffer.from(rowId, "utf8"))
    .digest();
  const b = hash.subarray(0, 16);
  b[6] = (b[6]! & 0x0f) | 0x50; // version 5
  b[8] = (b[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = b.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Normalized filter op → Qdrant condition builder.
function toQdrantCondition(field: string, op: FilterOp, value: unknown): object {
  switch (op) {
    case "eq":
      return { key: field, match: { value } };
    case "in":
      return { key: field, match: { any: value } };
    case "gt":
      return { key: field, range: { gt: value } };
    case "gte":
      return { key: field, range: { gte: value } };
    case "lt":
      return { key: field, range: { lt: value } };
    case "lte":
      return { key: field, range: { lte: value } };
  }
}

/** Translate a normalized filter into Qdrant's filter object (conditions ANDed via `must`). */
function toQdrantFilter(filter: QueryFilter): object {
  return { must: filter.map((c) => toQdrantCondition(c.field, c.op, c.value)) };
}

/** Qdrant-backed store for one collection. */
export class QdrantStore implements VectorStore {
  readonly service = "qdrant" as const;
  private readonly collection: string;

  constructor(collection: CollectionKey) {
    this.collection = COLLECTIONS[collection].qdrantCollection;
  }

  /** Create the collection (+ payload indexes) if it doesn't already exist. */
  async ensure(): Promise<void> {
    const qd = getQdrant();
    const { exists } = await qd.collectionExists(this.collection);
    if (exists) {
      logger.info("Collection already exists", { collection: this.collection });
      return;
    }
    await this.create();
  }

  private async create(): Promise<void> {
    const qd = getQdrant();
    await qd.createCollection(this.collection, {
      vectors: { size: EMBEDDING_DIMENSIONS, distance: DISTANCE_METRIC },
    });
    for (const field of INDEXED_INT_FIELDS) {
      await qd.createPayloadIndex(this.collection, { field_name: field, field_schema: "integer", wait: true });
    }
    logger.info("Created collection", { collection: this.collection, indexes: INDEXED_INT_FIELDS });
  }

  /** Drop and recreate the collection (cheaper + cleaner than deleting all points). */
  async reset(): Promise<void> {
    await getQdrant().deleteCollection(this.collection);
    await this.create();
    logger.info("Reset collection", { collection: this.collection });
  }

  async upsert(rows: VectorRow[]): Promise<void> {
    if (rows.length === 0) return;
    const qd = getQdrant();
    for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
      const points = rows.slice(i, i + UPSERT_BATCH).map((r) => ({
        id: toPointId(r.id),
        vector: r.vector,
        // Keep the original composite id so query results return it verbatim.
        payload: { ...r.metadata, [ROW_ID_KEY]: r.id },
      }));
      await qd.upsert(this.collection, { wait: true, points });
    }
  }

  /** Strip the reserved row-id key back out of the payload. */
  private static toMetadata(payload: Record<string, unknown> | null | undefined): Record<string, MetadataValue> {
    const metadata: Record<string, MetadataValue> = {};
    for (const [key, value] of Object.entries(payload ?? {})) {
      if (key !== ROW_ID_KEY) metadata[key] = value as MetadataValue;
    }
    return metadata;
  }

  async query(vector: number[], options: QueryOptions = {}): Promise<QueryHit[]> {
    const { topK = 10, filter } = options;
    const res = await getQdrant().query(this.collection, {
      query: vector,
      limit: topK,
      with_payload: true,
      with_vector: false, // never ship the raw vector back — inflates payload
      ...(filter ? { filter: toQdrantFilter(filter) } : {}),
    });
    // Qdrant's Cosine score is already similarity (higher = more similar), matching
    // Turbopuffer/Pinecone after their conversions.
    return (res.points ?? []).map((p) => {
      const payload = p.payload as Record<string, unknown> | null;
      return {
        id: String(payload?.[ROW_ID_KEY] ?? p.id),
        score: p.score ?? 0,
        metadata: QdrantStore.toMetadata(payload),
      };
    });
  }
}
