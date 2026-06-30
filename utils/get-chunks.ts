import { Prisma } from "@prisma/client";
import { prisma } from "../prisma/client";
import { createLogger } from "../logger";
import type { ChunkDocType } from "../consts";

const logger = createLogger("get-chunks");

// bill_embedding.doc_type uses the BillDocumentType enum. Re-exported from consts
// so existing importers (`import { ChunkDocType } from "../utils/get-chunks"`) keep working.
export type { ChunkDocType };

export type BillChunk = {
  id: number;
  doc_uuid: string;
  bill_uuid: string;
  chunk_id: number;
  content: string;
  embedding: number[];
};

// embedding as number[] directly: selecting `embedding::real[]` (not `::text`) lets
// Prisma deserialize the pgvector into a number[] in the query engine, skipping the
// per-row "[..]"->split->Number(x1536) JS parse that dominated read CPU (~2.8x faster).
type RawRow = BillChunk;

/**
 * Fetch existing chunks from bill_embedding for a given document type,
 * including the raw 1536-dim embedding vector.
 */
export async function fetchChunks(
  docType: ChunkDocType,
  options: { limit?: number } = {},
): Promise<BillChunk[]> {
  const { limit } = options;

  return prisma.$queryRaw<RawRow[]>`
    SELECT id, doc_uuid, bill_uuid, chunk_id, content, embedding::real[] AS embedding
    FROM bill_embedding
    WHERE doc_type = ${docType}::"BillDocumentType"
    ORDER BY doc_uuid, chunk_id
    ${limit ? Prisma.sql`LIMIT ${limit}` : Prisma.empty}
  `;
}

/**
 * Stream chunks for a document type in batches via keyset pagination on `id`,
 * so the whole table never has to be held in memory at once.
 */
export async function* streamChunks(
  docType: ChunkDocType,
  options: { batchSize?: number; limit?: number } = {},
): AsyncGenerator<BillChunk[]> {
  const { batchSize = 500, limit } = options;

  let cursor = 0;
  let fetched = 0;

  while (true) {
    const take = limit ? Math.min(batchSize, limit - fetched) : batchSize;
    if (take <= 0) break;

    const rows = await prisma.$queryRaw<RawRow[]>`
      SELECT id, doc_uuid, bill_uuid, chunk_id, content, embedding::real[] AS embedding
      FROM bill_embedding
      WHERE doc_type = ${docType}::"BillDocumentType" AND id > ${cursor}
      ORDER BY id
      LIMIT ${take}
    `;

    if (rows.length === 0) break;

    cursor = rows[rows.length - 1]!.id;
    fetched += rows.length;
    yield rows;

    if (rows.length < take) break;
  }
}

/**
 * Stream chunks for a specific set of bill_uuids, fetched in batches of uuids so
 * the IN list (and result set) stays bounded. Yields one batch per uuid group.
 */
export async function* streamChunksForBills(
  docType: ChunkDocType,
  billUuids: string[],
  options: { uuidBatchSize?: number } = {},
): AsyncGenerator<BillChunk[]> {
  const { uuidBatchSize = 100 } = options;

  for (let i = 0; i < billUuids.length; i += uuidBatchSize) {
    const slice = billUuids.slice(i, i + uuidBatchSize);
    if (slice.length === 0) continue;

    const rows = await prisma.$queryRaw<RawRow[]>`
      SELECT id, doc_uuid, bill_uuid, chunk_id, content, embedding::real[] AS embedding
      FROM bill_embedding
      WHERE doc_type = ${docType}::"BillDocumentType"
        AND bill_uuid IN (${Prisma.join(slice)})
      ORDER BY bill_uuid, doc_uuid, chunk_id
    `;

    if (rows.length) yield rows;
  }
}

async function main() {
  const docTypes: ChunkDocType[] = ["BILL_TEXT", "BILL_AMENDMENT"];

  for (const docType of docTypes) {
    const chunks = await fetchChunks(docType, { limit: 3 });
    logger.info("Fetched chunks", {
      docType,
      returned: chunks.length,
      sample: chunks[0] && {
        doc_uuid: chunks[0].doc_uuid,
        chunk_id: chunks[0].chunk_id,
        dims: chunks[0].embedding.length,
        content: chunks[0].content.slice(0, 80),
      },
    });
  }

  await prisma.$disconnect();
}

if (import.meta.main) {
  main().catch(async (error) => {
    logger.error("Fetch failed", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    await prisma.$disconnect();
    process.exit(1);
  });
}
