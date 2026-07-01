/**
 * OpenSearch-backed VectorStore: one k-NN index per collection. Uses a
 * `knn_vector` field (HNSW, cosine, Lucene engine — which supports efficient
 * filtered k-NN) and stores all metadata as regular fields for filtering.
 *
 * Handles index creation/reset, bulk upserts, and filtered k-NN queries.
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
import { DECENT_ATTRIBUTES } from "../../utils/vector-store";
import { createLogger } from "../../logger";
import { getOpenSearch } from "./client";

const logger = createLogger("opensearch");

const VECTOR_FIELD = "vector";
// OpenSearch bulk handles large bodies; match the ingest flush size so each flush is one bulk request.
const UPSERT_BATCH = 1000;

/** Index settings + mapping: a cosine HNSW knn_vector plus typed filter fields. */
function indexBody() {
  return {
    settings: { index: { knn: true } },
    mappings: {
      // Don't auto-map date-looking strings (e.g. bill_text_date) as `date`: values
      // are inconsistent (empty strings appear), which would conflict on later docs.
      // We filter on the numeric epoch, not these strings, so text mapping is fine.
      date_detection: false,
      properties: {
        [VECTOR_FIELD]: {
          type: "knn_vector",
          dimension: EMBEDDING_DIMENSIONS,
          method: {
            name: "hnsw",
            space_type: "cosinesimil",
            engine: "lucene", // Lucene engine supports filter inside the knn query
            parameters: { ef_construction: 128, m: 16 },
          },
        },
        // Typed so term/range filters work; other metadata is dynamically mapped.
        session_id: { type: "long" },
        notification_action_time_epoch: { type: "long" },
      },
    },
  };
}

// Normalized filter op → OpenSearch query clause builder.
function toOpenSearchClause(field: string, op: FilterOp, value: unknown): object {
  switch (op) {
    case "eq":
      return { term: { [field]: value } };
    case "in":
      return { terms: { [field]: value } };
    case "gt":
      return { range: { [field]: { gt: value } } };
    case "gte":
      return { range: { [field]: { gte: value } } };
    case "lt":
      return { range: { [field]: { lt: value } } };
    case "lte":
      return { range: { [field]: { lte: value } } };
  }
}

/** Translate a normalized filter into an OpenSearch bool filter (conditions ANDed). */
function toOpenSearchFilter(filter: QueryFilter): object {
  return { bool: { filter: filter.map((c) => toOpenSearchClause(c.field, c.op, c.value)) } };
}

/** OpenSearch-backed store for one collection (index). */
export class OpenSearchStore implements VectorStore {
  readonly service = "opensearch" as const;
  private readonly index: string;

  constructor(collection: CollectionKey) {
    this.index = COLLECTIONS[collection].opensearchIndex;
  }

  async ensure(): Promise<void> {
    const os = getOpenSearch();
    const { body: exists } = await os.indices.exists({ index: this.index });
    if (exists) {
      logger.info("Index already exists", { index: this.index });
      return;
    }
    await os.indices.create({ index: this.index, body: indexBody() });
    logger.info("Created index", { index: this.index });
  }

  /** Drop and recreate the index (cheaper + cleaner than delete-by-query). */
  async reset(): Promise<void> {
    const os = getOpenSearch();
    try {
      await os.indices.delete({ index: this.index });
    } catch (error: any) {
      if (error?.meta?.statusCode !== 404 && error?.statusCode !== 404) throw error;
    }
    await os.indices.create({ index: this.index, body: indexBody() });
    logger.info("Reset index", { index: this.index });
  }

  async upsert(rows: VectorRow[]): Promise<void> {
    if (rows.length === 0) return;
    const os = getOpenSearch();
    for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
      const slice = rows.slice(i, i + UPSERT_BATCH);
      const body = slice.flatMap((r) => [
        { index: { _index: this.index, _id: r.id } },
        { [VECTOR_FIELD]: r.vector, ...r.metadata },
      ]);
      const { body: res } = await os.bulk({ body });
      if (res.errors) {
        const firstErr = res.items.find((it: any) => it.index?.error)?.index?.error;
        logger.error("Bulk upsert had errors", { index: this.index, error: firstErr });
        throw new Error(`OpenSearch bulk upsert failed: ${JSON.stringify(firstErr)}`);
      }
    }
  }

  async query(vector: number[], options: QueryOptions = {}): Promise<QueryHit[]> {
    const { topK = 10, filter, attributePayload = "full" } = options;
    const knn: Record<string, unknown> = {
      [VECTOR_FIELD]: { vector, k: topK, ...(filter ? { filter: toOpenSearchFilter(filter) } : {}) },
    };
    // Payload level → _source selection:
    //   minimal — no _source at all (id + score only)
    //   decent  — only the small DECENT_ATTRIBUTES subset
    //   full    — all fields except the raw vector
    const source =
      attributePayload === "minimal"
        ? false
        : attributePayload === "decent"
          ? { includes: [...DECENT_ATTRIBUTES] }
          : { excludes: [VECTOR_FIELD] };
    const { body } = await getOpenSearch().search({
      index: this.index,
      body: {
        size: topK,
        query: { knn },
        _source: source,
      },
    });
    return (body.hits?.hits ?? []).map((hit: any) => ({
      id: String(hit._id),
      // cosinesimil score is (1 + cosine)/2 → recover cosine similarity for parity.
      score: typeof hit._score === "number" ? 2 * hit._score - 1 : 0,
      metadata: (hit._source ?? {}) as Record<string, MetadataValue>,
    }));
  }
}
