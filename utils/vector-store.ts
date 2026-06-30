/**
 * Service-agnostic vector-store contract.
 *
 * Each vector-db service (Turbopuffer, Pinecone, …) implements `VectorStore`
 * bound to a single logical collection. The common VectorIndexer fans rows out
 * across whichever stores are selected.
 */

/** Identifier for a vector-db backend. Add new ones here as they're implemented. */
export type ServiceName = "turbopuffer" | "pinecone" | "qdrant" | "opensearch";

/** Metadata value types accepted by both Turbopuffer and Pinecone. */
export type MetadataValue = string | number | boolean | string[] | number[];

/** A normalized row to index into any store. */
export type VectorRow = {
  id: string;
  vector: number[];
  metadata: Record<string, MetadataValue>;
};

/** Comparison operators for metadata filters, normalized across backends. */
export type FilterOp = "eq" | "gt" | "gte" | "lt" | "lte" | "in";

/** A single metadata filter condition. */
export type FilterCondition = {
  field: string;
  op: FilterOp;
  value: MetadataValue | MetadataValue[];
};

/** Metadata filter: a list of conditions ANDed together. Each store maps it to its own syntax. */
export type QueryFilter = FilterCondition[];

/** Options for a nearest-neighbor query. */
export type QueryOptions = {
  /** Number of nearest neighbors to return (default 10). */
  topK?: number;
  /**
   * Read consistency (Turbopuffer only; Pinecone serverless is always eventual).
   * Defaults to "eventual" — avoids the object-storage round-trip that strong
   * consistency requires, and matches Pinecone's model for a fair comparison.
   */
  consistency?: "strong" | "eventual";
  /** Metadata pre-filter applied before/with the vector search. */
  filter?: QueryFilter;
  /**
   * Return only document ids + score — no metadata, no vectors. Isolates raw
   * search latency from response-payload cost (e.g. large chunk_text/summary
   * fields), matching Turbopuffer's "control include_attributes" guidance.
   */
  minimal?: boolean;
  /**
   * Optional sink for the backend's server-side query diagnostics, called once
   * per query when the backend reports them (Turbopuffer only today; others
   * never call it). Lets the benchmark record cache warmth and how many
   * unindexed docs were exhaustively scanned without changing the hit shape.
   */
  onPerf?: (perf: QueryPerf) => void;
};

/**
 * Server-reported query diagnostics, normalized from a backend's native
 * performance block. All fields optional — a backend populates only what it
 * reports. See Turbopuffer's query `performance` object for field meanings.
 */
export type QueryPerf = {
  /** Qualitative cache state for the query: "hot" | "warm" | "cold". */
  cacheTemperature?: string;
  /** Ratio of cache hits to total cache lookups (0–1). */
  cacheHitRatio?: number;
  /** Server request time incl. concurrency-limit wait (ms). */
  serverTotalMs?: number;
  /** Server request time excl. concurrency-limit wait (ms). */
  queryExecutionMs?: number;
  /** Number of unindexed documents brute-force scanned by the query. */
  exhaustiveSearchCount?: number;
  /** Approximate number of documents in the namespace. */
  approxNamespaceSize?: number;
  /** Timestamp of the last write the query observed. */
  lastIncludedWriteAt?: string;
};

/**
 * One search result, normalized across backends. `score` is cosine similarity
 * (higher = more similar) regardless of how the backend reports it natively, so
 * Turbopuffer (cosine_distance) and Pinecone (cosine similarity) are comparable.
 */
export type QueryHit = {
  id: string;
  score: number;
  metadata: Record<string, MetadataValue>;
};

/** A vector store bound to one logical collection. */
export interface VectorStore {
  /** Which backend this store writes to. */
  readonly service: ServiceName;
  /** Create the underlying index/namespace if it doesn't exist. */
  ensure(): Promise<void>;
  /** Delete every vector in the collection. */
  reset(): Promise<void>;
  /** Upsert rows. Implementations handle their own internal batching/limits. */
  upsert(rows: VectorRow[]): Promise<void>;
  /** Nearest-neighbor search by vector, most-similar first. */
  query(vector: number[], options?: QueryOptions): Promise<QueryHit[]>;
  /** Optionally prewarm the index/namespace cache (no-op/absent if unsupported). */
  warm?(): Promise<void>;
}
