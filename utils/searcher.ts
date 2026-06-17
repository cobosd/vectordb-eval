/**
 * Question-answering search over one backend's collections.
 *
 * Ask a natural-language question → embed it once → query every collection
 * (bill_text + bill_amendment) for the top-K most similar chunks. Bound to a
 * single service so callers can hold one searcher per backend (e.g. to compare
 * Turbopuffer vs Pinecone on the same query).
 */

import { COLLECTION_KEYS, type CollectionKey } from "../consts";
import { createStore } from "./vector-indexer";
import { embed } from "./embedder";
import type { QueryHit, ServiceName, VectorStore } from "./vector-store";

/** Top-K hits for a single collection. */
export type CollectionHits = {
  collection: CollectionKey;
  hits: QueryHit[];
};

export class VectorSearcher {
  readonly service: ServiceName;
  private readonly stores: Array<{ collection: CollectionKey; store: VectorStore }>;

  constructor(service: ServiceName, collections: CollectionKey[] = COLLECTION_KEYS) {
    this.service = service;
    this.stores = collections.map((collection) => ({
      collection,
      store: createStore(service, collection),
    }));
  }

  /** Embed a question, then search every collection. */
  async search(question: string, topK = 10): Promise<CollectionHits[]> {
    return this.searchVector(await embed(question), topK);
  }

  /** Search every collection with an already-computed embedding (in parallel). */
  async searchVector(vector: number[], topK = 10): Promise<CollectionHits[]> {
    return Promise.all(
      this.stores.map(async ({ collection, store }) => ({
        collection,
        hits: await store.query(vector, { topK }),
      })),
    );
  }
}
