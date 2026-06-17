/**
 * Backend registry + fan-out indexer.
 *
 * `createStore` builds one VectorStore for a given (service, collection), and
 * `VectorIndexer` writes the same rows to several backends at once. Both read
 * the service list from a single registry, so adding a backend is a one-line change.
 */

import type { CollectionKey } from "../consts";
import { TurbopufferStore } from "../services/turbopuffer/store";
import { PineconeStore } from "../services/pinecone/store";
import { QdrantStore } from "../services/qdrant/store";
import { OpenSearchStore } from "../services/opensearch/store";
import { createLogger } from "../logger";
import type { ServiceName, VectorRow, VectorStore } from "./vector-store";

const logger = createLogger("vector-indexer");

/**
 * Registry of available vector-db backends. To add a service later, implement
 * VectorStore for it and add a factory entry here — nothing else changes.
 */
const STORE_FACTORIES: Record<ServiceName, (collection: CollectionKey) => VectorStore> = {
  turbopuffer: (collection) => new TurbopufferStore(collection),
  pinecone: (collection) => new PineconeStore(collection),
  qdrant: (collection) => new QdrantStore(collection),
  opensearch: (collection) => new OpenSearchStore(collection),
};

export const ALL_SERVICES = Object.keys(STORE_FACTORIES) as ServiceName[];

/** Build a single store for one (service, collection). Throws on unknown service. */
export function createStore(service: ServiceName, collection: CollectionKey): VectorStore {
  const factory = STORE_FACTORIES[service];
  if (!factory) throw new Error(`Unknown vector service: ${service}`);
  return factory(collection);
}

/**
 * Fans vector rows out to one or more backends for a single collection.
 * Defaults to all registered services; pass `services` to target a subset.
 */
export class VectorIndexer {
  private readonly stores: VectorStore[];

  constructor(collection: CollectionKey, options: { services?: ServiceName[] } = {}) {
    const services = options.services ?? ALL_SERVICES;
    this.stores = services.map((service) => createStore(service, collection));
  }

  /** Backends this indexer writes to. */
  get services(): ServiceName[] {
    return this.stores.map((s) => s.service);
  }

  async ensure(): Promise<void> {
    await Promise.all(this.stores.map((s) => s.ensure()));
  }

  async reset(): Promise<void> {
    await Promise.all(this.stores.map((s) => s.reset()));
  }

  async upsert(rows: VectorRow[]): Promise<void> {
    if (rows.length === 0) return;
    await Promise.all(this.stores.map((s) => s.upsert(rows)));
    logger.debug("Upserted", { services: this.services, rows: rows.length });
  }
}
