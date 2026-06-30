# Turbopuffer Ingest — Performance & Tuning

How the `scripts/ingest-*-turbopuffer.ts` backfills work, how we made them fast,
the default settings, and what to fine-tune per namespace.

## Scripts

| Script | Namespace(s) | Source | ~Chunks |
|---|---|---|---|
| `ingest-articles-turbopuffer.ts` | `article` | `article_embedding` | ~171k |
| `ingest-hearings-turbopuffer.ts` | `hearing` | `hearing_embedding` | ~2.0M |
| `ingest-bills-turbopuffer.ts` | `bill_text`, `bill_amendment` (split) | `bill_embedding` | ~4.5M + ~1.4M |
| `ingest-bills-sn-turbopuffer.ts` | `bill` (single namespace, `doc_type` attribute) | `bill_embedding` | ~5.9M combined |

All read precomputed 1536-dim embeddings from Postgres, join entity metadata, and
upsert one flat row per chunk into Turbopuffer (the only sink). Row ids are
idempotent (`${entity}::${chunk_id}` / `${doc_uuid}::${chunk_id}`), so re-runs
overwrite rather than duplicate — runs are resumable.

## How we improved the speed (37/s → ~1.2k/s, ~30×)

The pipeline is **read from Postgres → decode vector → upsert to Turbopuffer**. We
found and removed the bottleneck at each stage, in this order:

1. **Pipeline writes (overlap read & write).**
   Originally each batch was read, then written, then the next batch read — fully
   serial, so the network round-trip and the DB/CPU work each idled while the other
   ran. Fixed by keeping writes in flight while the next batch is prepared.

2. **Concurrent writes — `WRITE_CONCURRENCY` (the biggest single lever).**
   Each TP write returns in ~1–2.5s. Throughput ≈ `concurrency × batch ÷ latency`,
   so 1 write in flight tops out at ~half the namespace's capacity. Raising
   in-flight writes from 4 → 16 took a stuck bill load from **37/s to ~1.2k/s**.
   Writes were never being rate-limited (confirmed via `TPUF_DEBUG=1`: all `200`,
   ~1s, zero `429`); they were just concurrency-starved.

3. **Faster vector decode — `embedding::real[]` instead of `::text` (~2.8×).**
   pgvector's `::text` returns `"[0.1,0.2,…]"`, which we parsed in JS with
   `split(',').map(Number)` — 1536 `Number()` calls per row on the single Bun
   thread, the dominant read-side CPU cost. Selecting `embedding::real[]` instead
   lets Prisma deserialize the vector into a JS `number[]` in the query engine.
   Measured: 8,059 rows decoded in **22.0s → 7.95s**, identical values.

4. **Parallel reads — `READ_CONCURRENCY` (bills-sn only).**
   Even after the faster decode, chunk queries ran one at a time and couldn't keep
   the write pool fed for the largest dataset. A read pool runs several chunk
   queries concurrently (separate Prisma connections), each feeding the write pool.
   This is what let the bill load *hold* 1.2k/s instead of collapsing partway.

### Key findings (measured, not assumed)

- **FTS is not a write cost.** With vs without `full_text_search` on `content`:
  171/s vs 151/s — within noise. The vector (ANN) index dominates write cost, not
  the BM25 index. Deferring FTS to a post-ingest schema change would not help.
- **Batch size barely matters above ~1k.** 1000 rows → 148/s, 5000 → 171/s. The
  lever is *how many writes are in flight*, not how big each is.
- **Write latency rises as a namespace grows ("burst then settle").** A fresh
  namespace ingests fast (WAL phase); once it accumulates enough rows TP indexes in
  the background and per-write latency climbs. The early burst rate is not
  sustainable — the settled rate is the real one. Higher `WRITE_CONCURRENCY` hides
  the rising latency; a single 5.9M-row index is inherently slower at the tail.
- **Throughput anti-correlates with namespace size.** article (~171k) ran ~1.5k/s;
  hearing (~2.0M) ~300–500/s; bill single-namespace (~5.9M) was worst — every write
  maintains the index over everything already there.
- **Reads ≠ bottleneck after the fixes.** Read+decode is ~875–1000/s single-thread;
  with parallel reads it comfortably outpaces the write side.

### Diagnostics used (reach for these if it's slow again)

- **`TPUF_DEBUG=1`** (env, in `services/turbopuffer/client.ts`) logs every HTTP
  attempt with latency and flags `429`/timeouts to stderr. This is the decisive
  read/write/rate-limit triage:
  ```bash
  TPUF_DEBUG=1 WRITE_CONCURRENCY=16 bun scripts/ingest-bills-sn-turbopuffer.ts --bill-amendment 2>tpuf.log
  tail -f tpuf.log
  ```
  - `RATE-LIMITED`/`429` → TP capping the namespace; more concurrency just retries.
  - `200` with high `ms` → latency; raise `WRITE_CONCURRENCY`.
  - `200` fast but **sparse** lines → write pool starved → read-bound (raise
    `READ_CONCURRENCY` / check decode).
- **Instantaneous vs average rate.** The progress bar's `N/s` is a *cumulative
  average* and lags reality — a fast start keeps it high after the real rate drops.
  Compute instantaneous: `(rows₂ − rows₁) ÷ (t₂ − t₁)`.
- **Memory / GC.** `while true; do ps -o rss= -p $(pgrep -f ingest-bills) | awk '{print $1/1024" MB"}'; sleep 2; done`
  — flat sawtooth under ~1GB is healthy; a climb toward multi-GB right as
  throughput drops means in-flight rows (concurrency × batch) are too high.

## Default settings

Set per script; every value below is overridable by the matching `process.env.*`
(or `--namespace` flag). Batch/concurrency are env vars; the rest are constants.

| Setting | Env var | articles | hearings | bills (split) | bills-sn |
|---|---|---|---|---|---|
| Namespace | `--namespace=` | `article` | `hearing` | `bill_text`/`bill_amendment` | `bill` |
| Write batch size | `UPSERT_BATCH_SIZE` | 2000 | 2000 | 2000 | 2000 |
| Concurrent writes | `WRITE_CONCURRENCY` | 4 | 4 | 4 | **16** |
| Concurrent reads | `READ_CONCURRENCY` | — | — | — | **4** |
| Ids per chunk query | (constant) | 100 | 100 | 100 | 100 |
| Ids per metadata query | (constant) | 1000 | 1000 | 1000 | 1000 |
| FTS on `content` | (schema) | english + stemming + stopwords | same | same | same |

Notes:
- **Only `ingest-bills-sn-turbopuffer.ts` has parallel reads** (`READ_CONCURRENCY`)
  and the raised `WRITE_CONCURRENCY=16` default — it carries the largest dataset.
  The others still default to `WRITE_CONCURRENCY=4` and serial reads.
- **All four** already use the fast `::real[]` decode and pipelined/concurrent
  writes.
- `READ_CONCURRENCY` must stay **≤ the Prisma `connection_limit`** in `DB_URL`, or
  reads queue on the connection pool. Bump `connection_limit` to go higher.
- Datetime attributes (`event_date`, `post_date`, `notification_action_time`) are
  only set when present — an empty string fails TP's `datetime` parse and would
  reject the whole batch.

## What to fine-tune, per namespace

General rule: **raise `WRITE_CONCURRENCY` until throughput stops improving or
`tpuf.log` shows `429`s; then stop.** On a low-latency host (in-region EC2) the
sweet spot is much higher than off a laptop. Watch memory — `WRITE_CONCURRENCY ×
UPSERT_BATCH_SIZE` rows are held in flight.

### `article` (~171k chunks — small)
- Smallest namespace; never hits indexing backpressure. Already ~1.5k/s at the
  defaults.
- To speed up: `WRITE_CONCURRENCY=12–16`. Reads are not the gate here.
  ```bash
  WRITE_CONCURRENCY=12 bun scripts/ingest-articles-turbopuffer.ts --reset
  ```

### `hearing` (~2.0M chunks — medium, large transcript content ~2.3KB/row)
- Bigger payload per row, so it's the most write-byte-heavy.
- Raise `WRITE_CONCURRENCY=12–16`. If `tpuf.log` shows fast-but-sparse writes
  (read-starved), it would benefit from the bills-sn read-pool pattern (not yet
  ported here — ask if needed).
  ```bash
  WRITE_CONCURRENCY=16 bun scripts/ingest-hearings-turbopuffer.ts --reset
  ```

### `bill_text` / `bill_amendment` split (~4.5M / ~1.4M)
- Two smaller namespaces index independently — each sustains a higher rate than the
  combined single namespace.
- `WRITE_CONCURRENCY=12–16`. Uses the shared serial read path (`utils/get-chunks.ts`,
  already on `::real[]`); fine because each namespace is smaller.

### `bill` single-namespace (~5.9M combined — largest, slowest)
- The hard case: every write maintains one index over up to 5.9M rows, so the tail
  is the slowest part. This is where parallel reads + high write concurrency matter
  most.
- Tuned values that held ~1.2k/s on in-region EC2:
  ```bash
  WRITE_CONCURRENCY=16 READ_CONCURRENCY=4 bun scripts/ingest-bills-sn-turbopuffer.ts --bill-amendment
  ```
- Push `WRITE_CONCURRENCY` to 24–32 if the tail sags **and** `tpuf.log` stays
  `429`-free. If throughput collapses while writes are fast-but-sparse, raise
  `READ_CONCURRENCY` (and `connection_limit`) instead.
- **Load order:** ingest into the same `bill` namespace without `--reset` between
  doc types (`--bill-amendment` then `--bill-text`, or vice versa). `--reset` wipes
  the whole namespace, so only pass it on the *first* run.
- Lower `WRITE_CONCURRENCY`/`UPSERT_BATCH_SIZE` only if memory climbs toward
  multiple GB (in-flight rows = concurrency × batch).

## Common flags (all scripts)

```
--reset                wipe the namespace before ingesting (single ns: once, up front)
--dry-run              print the selected ids and exit (no writes)
--limit=N              cap to N entities (handy for a quick rate check before a full run)
--start=YYYY-MM-DD     inclusive date lower bound (entity's date column)
--end=YYYY-MM-DD       inclusive date upper bound
--namespace=NAME       override the target namespace
--skip-file=PATH       skip ids listed one-per-line (resume against a prior run)
--bill-text / --bill-amendment   (bills only) restrict to one doc type
```

Requires `DB_URL` + `TURBOPUFFER_API_KEY` in `.env` (auto-loaded by Bun).
