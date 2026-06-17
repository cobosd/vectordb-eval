import type { CollectionKey } from "../consts";
import type { MetadataValue } from "./vector-store";

export type BillMeta = Record<string, MetadataValue>;

/** The per-collection date field name carried in metadata. */
const DATE_FIELD: Record<CollectionKey, string> = {
  bill_text: "bill_text_date",
  bill_amendment: "amendment_date",
};

/** Parse an ISO date string to epoch ms; 0 when absent/unparseable. */
export function toEpoch(value: unknown): number {
  if (typeof value !== "string" || !value) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Build the doc-level metadata stored on every chunk, from a JSONL bill record.
 * Shared by all ingest paths so every row in a collection carries the same shape
 * (matching the Turbopuffer FTS schema). Chunk-level fields (doc_uuid, bill_uuid,
 * chunk_id, chunk_text) are added by the caller. Values are coalesced (never null)
 * so Pinecone accepts them.
 */
export function buildBillMetadata(record: Record<string, any>, collection: CollectionKey): BillMeta {
  const dateField = DATE_FIELD[collection];
  return {
    bill_number_normalized: record.bill_number_normalized ?? "",
    session_id: record.session_id ?? 0,
    notification_action_time: record.notification_action_time ?? "",
    // Numeric epoch (ms) so both backends can range-filter the date (Pinecone can't range a string).
    notification_action_time_epoch: toEpoch(record.notification_action_time),
    has_dead_progress_status: record.has_dead_progress_status ?? false,
    is_active: record.is_active ?? false,
    hide: record.hide ?? false,
    s3_url: record.s3_url ?? "",
    summary: record.summary ?? "",
    [dateField]: record[dateField] ?? "",
  };
}
