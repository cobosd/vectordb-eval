import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { COLLECTION_KEYS, COLLECTIONS, type CollectionKey } from "../consts";
import { prisma } from "../prisma/client";
import { streamChunksForBills } from "../utils/get-chunks";
import { VectorIndexer } from "../utils/vector-indexer";
import { buildBillMetadata, type BillMeta } from "../utils/bill-metadata";
import { openCacheWriter, streamCacheRows } from "../utils/vector-cache";
import type { ServiceName, VectorRow } from "../utils/vector-store";
import { createLogger } from "../logger";

const logger = createLogger("ingest-from-postgres");

const DATA_DIR = new URL("../data/", import.meta.url);
const TEXT_FILE = new URL("bill-text.jsonl", DATA_DIR);
const AMENDMENT_FILE = new URL("bill-amendment.jsonl", DATA_DIR);

// Where fully-assembled rows (id + vector + metadata) are cached as JSONL, so a
// re-ingest can read everything from disk instead of refetching from Postgres.
const CACHE_DIR = new URL("cache/", DATA_DIR);
const cachePath = (collection: CollectionKey): string =>
  new URL(`${collection}.vectors.jsonl`, CACHE_DIR).pathname;

// How many distinct bills (from bill-text.jsonl, in file order) to ingest.
const BILL_LIMIT = process.env.BILL_LIMIT ? Number(process.env.BILL_LIMIT) : 5000;
// bill_uuids per Postgres query (bounds the IN list and chunks held at once).
const UUID_BATCH_SIZE = 25;
// Rows accumulated before a flush to the stores.
const UPSERT_BATCH_SIZE = 1000;
// Pass --reset to wipe each collection before ingesting.
const RESET = process.argv.includes("--reset");
// Pass --from-cache to read assembled rows from data/cache/*.vectors.jsonl
// (written by a prior Postgres ingest) instead of querying Postgres at all.
const FROM_CACHE = process.argv.includes("--from-cache");
// Pass --no-cache to skip writing the JSONL cache during a Postgres ingest.
const NO_CACHE = process.argv.includes("--no-cache");
// Pass --services=turbopuffer,pinecone to target a subset (default: all).
const servicesArg = process.argv.find((a) => a.startsWith("--services="));
const SERVICES = servicesArg
  ? (servicesArg.slice("--services=".length).split(",").filter(Boolean) as ServiceName[])
  : undefined;

// Source JSONL (doc metadata) for each collection.
const JSONL_FOR: Record<CollectionKey, URL> = {
  bill_text: TEXT_FILE,
  bill_amendment: AMENDMENT_FILE,
};

/**
 * Normalize a user-supplied dataset name to a CollectionKey. Accepts the key
 * itself plus friendly spellings ("bill text", "bill-amendment").
 */
function parseCollections(raw: string): CollectionKey[] {
  const keys = raw
    .split(",")
    .map((s) => s.trim().toLowerCase().replace(/[\s-]+/g, "_"))
    .filter(Boolean);
  for (const k of keys) {
    if (!COLLECTION_KEYS.includes(k as CollectionKey)) {
      throw new Error(`Unknown collection "${k}". Valid: ${COLLECTION_KEYS.join(", ")}`);
    }
  }
  return keys as CollectionKey[];
}

// Pass --collection=bill_text,bill_amendment to target specific datasets (default: all).
const collectionArg = process.argv.find((a) => a.startsWith("--collection="));
const SELECTED_COLLECTIONS: CollectionKey[] = collectionArg
  ? parseCollections(collectionArg.slice("--collection=".length))
  : COLLECTION_KEYS;

// Pass --uuids-file=<path> to ingest exactly the bill_uuids in that JSON array,
// instead of selecting the first BILL_LIMIT bills from bill-text.jsonl.
const uuidsFileArg = process.argv.find((a) => a.startsWith("--uuids-file="));
const UUIDS_FILE = uuidsFileArg ? uuidsFileArg.slice("--uuids-file=".length) : undefined;

/**
 * Read a JSONL file once, building a doc_uuid -> metadata map (full_content dropped)
 * and the list of distinct bill_uuids in first-appearance (file) order.
 */
async function indexJsonl(
  file: URL,
  collection: CollectionKey,
): Promise<{ metaByDoc: Map<string, BillMeta>; billOrder: string[] }> {
  const metaByDoc = new Map<string, BillMeta>();
  const seen = new Set<string>();
  const billOrder: string[] = [];

  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line);
    metaByDoc.set(rec.doc_uuid, buildBillMetadata(rec, collection));
    if (rec.bill_uuid && !seen.has(rec.bill_uuid)) {
      seen.add(rec.bill_uuid);
      billOrder.push(rec.bill_uuid);
    }
  }
  rl.close();

  return { metaByDoc, billOrder };
}

/**
 * Pick which bills to ingest: the first `billLimit` distinct bill_uuids in
 * bill-text.jsonl file order. Both datasets ingest the same set of bills.
 */
export async function selectBillUuids(billLimit = BILL_LIMIT): Promise<string[]> {
  const { billOrder } = await indexJsonl(TEXT_FILE, "bill_text");
  logger.info("Selected bills", {
    distinctInFile: billOrder.length,
    selected: Math.min(billOrder.length, billLimit),
    billLimit,
  });
  return billOrder.slice(0, billLimit);
}

/**
 * Trigger indexing for a single dataset (collection). Loads that dataset's doc
 * metadata, streams its chunks for `billUuids` from Postgres, enriches each
 * chunk with metadata, and fans the rows out to the selected vector stores.
 */
export async function ingestCollection(
  collection: CollectionKey,
  billUuids: string[],
  options: { services?: ServiceName[]; reset?: boolean; fromCache?: boolean; cache?: boolean } = {},
): Promise<{ chunks: number; missingMeta: number }> {
  const indexer = new VectorIndexer(collection, { services: options.services });
  await indexer.ensure();
  if (options.reset) await indexer.reset();

  let chunks = 0;
  let writes = 0;
  let buffer: VectorRow[] = [];

  const flush = async () => {
    if (buffer.length === 0) return;
    await indexer.upsert(buffer);
    chunks += buffer.length;
    writes++;
    logger.info("Progress", { collection, write: writes, chunks });
    buffer = [];
  };

  // Fast path: replay fully-assembled rows from the JSONL cache, no Postgres.
  if (options.fromCache) {
    const path = cachePath(collection);
    logger.info("Ingesting from cache", { collection, services: indexer.services, cache: path });
    for await (const batch of streamCacheRows(path, UPSERT_BATCH_SIZE)) {
      buffer = batch;
      await flush();
    }
    logger.info("Collection done", { collection, chunks, source: "cache" });
    return { chunks, missingMeta: 0 };
  }

  const { docType } = COLLECTIONS[collection];
  const { metaByDoc } = await indexJsonl(JSONL_FOR[collection], collection);
  const cacheWriter = options.cache ? await openCacheWriter(cachePath(collection)) : null;

  logger.info("Ingesting from Postgres", {
    collection,
    docType,
    services: indexer.services,
    bills: billUuids.length,
    cache: cacheWriter ? cachePath(collection) : "disabled",
  });

  let missingMeta = 0;

  for await (const batch of streamChunksForBills(docType, billUuids, { uuidBatchSize: UUID_BATCH_SIZE })) {
    for (const c of batch) {
      const meta = metaByDoc.get(c.doc_uuid);
      if (!meta) missingMeta++;
      const row: VectorRow = {
        id: `${c.doc_uuid}::${c.chunk_id}`,
        vector: c.embedding,
        metadata: {
          doc_uuid: c.doc_uuid,
          bill_uuid: c.bill_uuid,
          chunk_id: c.chunk_id,
          chunk_text: c.content,
          ...(meta ?? {}),
        },
      };
      cacheWriter?.write(row);
      buffer.push(row);
      if (buffer.length >= UPSERT_BATCH_SIZE) await flush();
    }
  }
  await flush();
  await cacheWriter?.close();

  logger.info("Collection done", { collection, chunks, missingMeta });
  return { chunks, missingMeta };
}

/** Load a JSON array of bill_uuids from a file. */
async function loadBillUuids(path: string): Promise<string[]> {
  const uuids = (await Bun.file(path).json()) as unknown;
  if (!Array.isArray(uuids) || !uuids.every((u) => typeof u === "string")) {
    throw new Error(`${path} must contain a JSON array of bill_uuid strings`);
  }
  logger.info("Loaded bill_uuids from file", { path, count: uuids.length });
  return uuids;
}

async function main() {
  // From cache we replay assembled rows off disk — no bill selection, no Postgres.
  const billUuids = FROM_CACHE ? [] : UUIDS_FILE ? await loadBillUuids(UUIDS_FILE) : await selectBillUuids();

  for (const collection of SELECTED_COLLECTIONS) {
    await ingestCollection(collection, billUuids, {
      services: SERVICES,
      reset: RESET,
      fromCache: FROM_CACHE,
      cache: !NO_CACHE,
    });
  }

  if (!FROM_CACHE) await prisma.$disconnect();
  logger.info("All collections ingested", { collections: SELECTED_COLLECTIONS, source: FROM_CACHE ? "cache" : "postgres" });
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
