/**
 * Pinecone-backed VectorStore: one dense serverless index per collection.
 * Handles index creation/reset, batched upserts (with metadata-size trimming to
 * stay under Pinecone's 40KB/record limit), and nearest-neighbor queries.
 */

import { Buffer } from "node:buffer";
import type { RecordMetadata } from "@pinecone-database/pinecone";
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
import { getPinecone } from "./client";

const logger = createLogger("pinecone");

// Normalized filter op → Pinecone operator.
const PC_OPS: Record<FilterOp, string> = {
  eq: "$eq",
  gt: "$gt",
  gte: "$gte",
  lt: "$lt",
  lte: "$lte",
  in: "$in",
};

/** Translate a normalized filter into Pinecone's Mongo-style filter (conditions ANDed). */
function toPineconeFilter(filter: QueryFilter): object {
  const clauses = filter.map((c) => ({ [c.field]: { [PC_OPS[c.op]]: c.value } }));
  return clauses.length === 1 ? clauses[0]! : { $and: clauses };
}

// Pinecone caps upsert payloads (~2MB / request) — keep batches small.
const UPSERT_BATCH = 100;
// Pinecone rejects the whole request if any record's metadata exceeds 40KB.
// Stay under that with headroom; truncate the largest free-text fields to fit.
const MAX_METADATA_BYTES = 38_000;
// Free-text fields to shrink (in order) when a record's metadata is too large.
const TRUNCATABLE_FIELDS = ["chunk_text", "summary"];

const byteLen = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

/** Longest prefix of `s` whose UTF-8 length is <= maxBytes. */
function truncateToBytes(s: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (Buffer.byteLength(s.slice(0, mid), "utf8") <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return s.slice(0, lo);
}

/** Truncate free-text fields so the metadata fits Pinecone's 40KB limit. Returns whether it was trimmed. */
function fitMetadata(metadata: Record<string, MetadataValue>): { metadata: RecordMetadata; truncated: boolean } {
  if (byteLen(metadata) <= MAX_METADATA_BYTES) return { metadata: metadata as RecordMetadata, truncated: false };

  const fitted: Record<string, MetadataValue> = { ...metadata };
  for (const field of TRUNCATABLE_FIELDS) {
    if (byteLen(fitted) <= MAX_METADATA_BYTES) break;
    if (typeof fitted[field] !== "string") continue;
    // Budget = limit minus everything else (this field emptied).
    const overhead = byteLen({ ...fitted, [field]: "" });
    fitted[field] = truncateToBytes(fitted[field] as string, MAX_METADATA_BYTES - overhead);
  }
  return { metadata: fitted as RecordMetadata, truncated: true };
}

/** Pinecone-backed store for one collection (index). */
export class PineconeStore implements VectorStore {
  readonly service = "pinecone" as const;
  private readonly indexName: string;

  constructor(collection: CollectionKey) {
    this.indexName = COLLECTIONS[collection].pineconeIndex;
  }

  /** Create the index if missing, or recreate it if it has the wrong dimension. */
  async ensure(): Promise<void> {
    const pc = getPinecone();
    const existing = await pc.listIndexes();
    const current = existing.indexes?.find((i) => i.name === this.indexName);

    if (current && current.dimension !== EMBEDDING_DIMENSIONS) {
      logger.info("Deleting index with wrong dimension", {
        name: this.indexName,
        dimension: current.dimension,
      });
      await pc.deleteIndex(this.indexName);
    }

    if (!current || current.dimension !== EMBEDDING_DIMENSIONS) {
      logger.info("Creating index", { name: this.indexName, dimension: EMBEDDING_DIMENSIONS });
      await pc.createIndex({
        name: this.indexName,
        dimension: EMBEDDING_DIMENSIONS,
        metric: "cosine",
        spec: { serverless: { cloud: "aws", region: "us-east-1" } },
        waitUntilReady: true,
      });
    } else {
      logger.info("Index already exists", { name: this.indexName });
    }
  }

  async reset(): Promise<void> {
    try {
      await getPinecone().index(this.indexName).deleteAll();
      logger.info("Reset index", { name: this.indexName });
    } catch (error: any) {
      // 404 = namespace/index has no vectors yet. PineconeNotFoundError carries
      // no numeric status, so match on the error name.
      if (error?.name === "PineconeNotFoundError" || error?.status === 404) {
        logger.info("Reset skipped (index empty)", { name: this.indexName });
      } else {
        throw error;
      }
    }
  }

  async upsert(rows: VectorRow[]): Promise<void> {
    if (rows.length === 0) return;
    const index = getPinecone().index(this.indexName);

    let truncated = 0;
    for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
      const records = rows.slice(i, i + UPSERT_BATCH).map((r) => {
        const fit = fitMetadata(r.metadata);
        if (fit.truncated) truncated++;
        return { id: r.id, values: r.vector, metadata: fit.metadata };
      });
      await index.upsert({ records });
    }
    if (truncated > 0) {
      logger.warn("Truncated oversized metadata to fit Pinecone limit", {
        index: this.indexName,
        records: truncated,
        maxBytes: MAX_METADATA_BYTES,
      });
    }
  }

  async query(vector: number[], options: QueryOptions = {}): Promise<QueryHit[]> {
    const { topK = 10, filter, minimal } = options;
    // Default namespace — matches how upsert() writes (no namespace override).
    const res = await getPinecone().index(this.indexName).query({
      vector,
      topK,
      includeMetadata: !minimal, // minimal: id + score only
      includeValues: false, // never ship the raw vector back — inflates payload, esp. at high topK
      ...(filter ? { filter: toPineconeFilter(filter) } : {}),
    });
    // Return all metadata (the vector is already excluded via includeValues:false).
    // Pinecone's cosine score is already similarity (higher = more similar).
    return (res.matches ?? []).map((m) => ({
      id: m.id,
      score: m.score ?? 0,
      metadata: (m.metadata ?? {}) as Record<string, MetadataValue>,
    }));
  }
}
