/**
 * On-disk cache of fully-assembled vector rows (id + vector + metadata) as JSONL,
 * one row per line. Lets a re-ingest read everything from disk instead of
 * re-fetching embeddings from Postgres and re-joining JSONL metadata.
 *
 * The vector is stored as a base64-encoded Float32 blob rather than a JSON number
 * array: ~2.5x smaller on disk, much faster to parse, and lossless (we store f32).
 * Metadata stays plain JSON so the file is still greppable/inspectable.
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { MetadataValue, VectorRow } from "./vector-store";

/** One cached row as serialized to JSONL. `v` is a base64 Float32 vector blob. */
type CacheRow = { id: string; v: string; metadata: Record<string, MetadataValue> };

/** Encode an f32 vector as a base64 Float32 blob. */
export function encodeVector(vector: number[]): string {
  const f32 = new Float32Array(vector);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength).toString("base64");
}

/** Decode a base64 Float32 blob back to a plain number[]. */
export function decodeVector(b64: string): number[] {
  const buf = Buffer.from(b64, "base64");
  // Copy into a fresh, 4-byte-aligned ArrayBuffer — Buffer pool offsets aren't
  // guaranteed aligned, and Float32Array requires a multiple-of-4 byte offset.
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return Array.from(new Float32Array(ab));
}

/** A streaming writer that appends assembled rows to a JSONL cache file. */
export interface CacheWriter {
  write(row: VectorRow): void;
  close(): Promise<void>;
}

/**
 * Open a JSONL cache file for writing (truncating any existing file). Creates the
 * parent directory if needed.
 */
export async function openCacheWriter(path: string): Promise<CacheWriter> {
  await mkdir(dirname(path), { recursive: true });
  const sink = Bun.file(path).writer();
  return {
    write(row: VectorRow) {
      const line: CacheRow = { id: row.id, v: encodeVector(row.vector), metadata: row.metadata };
      sink.write(JSON.stringify(line) + "\n");
    },
    async close() {
      await sink.end();
    },
  };
}

/** Stream cached rows back as VectorRow batches of `batchSize`. */
export async function* streamCacheRows(path: string, batchSize = 1000): AsyncGenerator<VectorRow[]> {
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  let buffer: VectorRow[] = [];
  for await (const line of rl) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line) as CacheRow;
    buffer.push({ id: rec.id, vector: decodeVector(rec.v), metadata: rec.metadata });
    if (buffer.length >= batchSize) {
      yield buffer;
      buffer = [];
    }
  }
  rl.close();
  if (buffer.length) yield buffer;
}
