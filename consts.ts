/**
 * Single source of truth for vector collections.
 *
 * Each logical collection maps to a namespace/index name per vector-db service.
 * All services (Turbopuffer, Pinecone, …) read their identifiers from here so the
 * naming stays in sync across the codebase.
 */

/** Dimension of the embeddings we store (OpenAI text-embedding-3-small). */
export const EMBEDDING_DIMENSIONS = 1536;

/** bill_embedding.doc_type enum values. */
export type ChunkDocType = "BILL_TEXT" | "BILL_AMENDMENT";

/** Logical collection keys. */
export type CollectionKey = "bill_text" | "bill_amendment" | "bill";

export type CollectionConfig = {
  key: CollectionKey;
  /** Postgres bill_embedding.doc_type this collection draws from. */
  docType: ChunkDocType;
  /** Turbopuffer namespace name. */
  turbopufferNamespace: string;
  /** Pinecone index name (no underscores allowed). */
  pineconeIndex: string;
  /** Qdrant collection name. */
  qdrantCollection: string;
  /** OpenSearch index name (lowercase, no leading _ or -). */
  opensearchIndex: string;
};

export const COLLECTIONS: Record<CollectionKey, CollectionConfig> = {
  bill_text: {
    key: "bill_text",
    docType: "BILL_TEXT",
    turbopufferNamespace: "bill_text",
    pineconeIndex: "bill-text",
    qdrantCollection: "bill_text",
    opensearchIndex: "bill_text",
  },
  bill_amendment: {
    key: "bill_amendment",
    docType: "BILL_AMENDMENT",
    turbopufferNamespace: "bill_amendment",
    pineconeIndex: "bill-amendment",
    qdrantCollection: "bill_amendment",
    opensearchIndex: "bill_amendment",
  },
  // Single-namespace ("sn") variant: BOTH doc types live in one namespace `bill`
  // (see ingest-bills-sn-turbopuffer.ts), scoped by a doc_type filter instead of
  // separate namespaces. docType here is nominal — this collection is a benchmark
  // target for performance.ts (--collections=bill), not an ingest source, so
  // COLLECTION_KEYS below intentionally excludes it.
  bill: {
    key: "bill",
    docType: "BILL_TEXT",
    turbopufferNamespace: "bill",
    pineconeIndex: "bill",
    qdrantCollection: "bill",
    opensearchIndex: "bill",
  },
};

/**
 * Default two-namespace collections — the ingest/search/eval source of truth.
 * Kept explicit (not `Object.keys(COLLECTIONS)`) so adding a benchmark-only
 * collection like `bill` doesn't leak into ingest, searcher, or run-eval.
 */
export const COLLECTION_KEYS: CollectionKey[] = ["bill_text", "bill_amendment"];
