# vectordb-eval

A harness for comparing vector databases — **Turbopuffer**, **Pinecone**, and **Qdrant** —
on legislative-bill semantic search. It ingests the same embedded chunks into each service
across two collections (`bill_text`, `bill_amendment`) and benchmarks query latency, with and
without metadata filtering.

- **What's compared & why:** see [NOTES.md](NOTES.md) (per-service capabilities, limitations,
  deployment models, and cost).
- **Fair latency testing:** see [docs/EC2-BENCHMARK.md](docs/EC2-BENCHMARK.md) — laptop numbers
  are dominated by the public-internet hop; run from in-region EC2 to measure engines.

---

## Dashboard

A Next.js (App Router) dashboard visualizes the eval results. It reads `evals/*.md`
and `NOTES.md` at **build time** and renders fully static pages — interactive charts +
a sortable/filterable data table, an eval-run picker, and a `/notes` page.

- Frontend lives under [src/](src/) (`src/app`, `src/components`, `src/lib`); the parser is
  [src/lib/eval-data.ts](src/lib/eval-data.ts), the build-time loader is
  [src/lib/load-evals.ts](src/lib/load-evals.ts).
- Run locally: `bun install && bun dev` → http://localhost:3000
  (`bun run build` / `bun run start` for the production build).
- **Deploy to Vercel:** import the repo — Next.js is auto-detected at the root, no Root
  Directory or extra settings needed. Pages are static, so **adding/editing an eval requires
  a redeploy** to appear.

> The Bun eval harness (below) and the dashboard share this repo. `next build` only
> type-checks `src/` (see `tsconfig.json`); the harness keeps its own settings in
> `tsconfig.harness.json` and runs via Bun.

## Prerequisites

- [Bun](https://bun.sh) (this repo uses Bun, not Node — `bun <file>`, `bun install`, etc.)
- **OpenAI** API key (embeddings: `text-embedding-3-small`, 1536 dims).
- **Turbopuffer** + **Pinecone** API keys.
- **Qdrant**: either Qdrant Cloud (URL + API key) or a local Docker instance
  (`docker run -d -p 6333:6333 qdrant/qdrant`).
- **Postgres** with a `bill_embedding` table — only needed to *ingest from source*. Once the
  on-disk cache exists you can re-ingest without Postgres (`--from-cache`).

## Setup

```bash
bun install
```

Create a `.env` (Bun loads it automatically — do not add `dotenv`):

```env
OPENAI_API_KEY=sk-...
TURBOPUFFER_API_KEY=tpuf-...
PINECONE_API_KEY=...
# Qdrant — cloud:
QDRANT_URL=https://<id>.us-east-1-1.aws.cloud.qdrant.io
QDRANT_API_KEY=...
# Qdrant — local Docker (no key needed): QDRANT_URL=http://localhost:6333
# Postgres (only for ingesting from source):
DATABASE_URL=postgres://...
```

`.env`, the large `data/*.jsonl` source dumps, `data/cache/`, and `qdrant_storage/` are
gitignored.

---

## Layout

```
services/<name>/client.ts   # lazily-constructed SDK client (reads keys from config)
services/<name>/store.ts     # VectorStore impl: ensure / reset / upsert / query [/ warm]
utils/vector-store.ts        # the service-agnostic VectorStore contract + filter types
utils/vector-indexer.ts      # service registry + fan-out indexer (createStore, VectorIndexer)
utils/vector-cache.ts        # JSONL row cache (base64-f32 vectors) for Postgres-free re-ingest
utils/embedder.ts            # OpenAI embedding helpers
consts.ts                    # collections → per-service namespace/index/collection names
config.ts                    # env-backed config
scripts/                     # ingest + benchmarks (below)
```

Adding a service is a one-line change in `utils/vector-indexer.ts` once its `store.ts` exists.

---

## Per-service defaults

All three: **cosine** similarity, **1536** dims, the raw vector is **excluded** from query
responses, and `score` is normalized to cosine similarity (higher = more similar).

| | Turbopuffer | Pinecone | Qdrant |
|---|---|---|---|
| Hosting | Managed SaaS, region `aws-us-east-1` | Serverless, `aws` / `us-east-1` | Cloud or local Docker (`QDRANT_URL`) |
| Names | namespaces `bill_text`, `bill_amendment` | indexes `bill-text`, `bill-amendment` | collections `bill_text`, `bill_amendment` |
| Read consistency | tunable (`strong`/`eventual`) | always eventual (no knob) | n/a (replica quorum only) |
| Filterable fields | filterable string attrs; `chunk_text`/`summary` set non-filterable | all metadata indexed automatically | integer payload indexes on `session_id` + `notification_action_time_epoch` |
| Point/record IDs | `doc_uuid::chunk_id` (string) | `doc_uuid::chunk_id` (string) | UUIDv5 of the id; original kept in `__row_id` |
| Upsert batch | n/a (512MB/request) | 100 (~2MB cap), metadata trimmed to 38KB | 500 |
| Cache prewarm | `hintCacheWarm()` via `warm()` | none (throwaway query) | none |
| Returned metadata | all (minus vector) | all (cannot trim server-side) | all (minus vector) |

Date range filtering uses a numeric `notification_action_time_epoch` (ms) on every row, because
Pinecone can't range-filter a string date. It's written natively by the ingester.

---

## Scripts & flags

### `scripts/ingest-from-postgres.ts` — populate the services

Builds embedded rows and fans them out to the selected services. Writes a JSONL cache of every
assembled row (id + base64-f32 vector + metadata) so future re-ingests can skip Postgres.

| Flag | Default | Meaning |
|---|---|---|
| `--services=a,b` | all (`turbopuffer,pinecone,qdrant`) | which backends to write to |
| `--collection=a,b` | both | `bill_text` and/or `bill_amendment` |
| `--uuids-file=<path>` | first `BILL_LIMIT` bills | ingest exactly the bill_uuids in a JSON array |
| `--reset` | off | wipe each target collection before ingesting |
| `--from-cache` | off | read assembled rows from `data/cache/*.vectors.jsonl` — **no Postgres** |
| `--no-cache` | off | don't write the cache during a Postgres ingest |
| `BILL_LIMIT` (env) | `5000` | how many distinct bills to select when no `--uuids-file` |

```bash
# Fresh from Postgres for a specific bill set, all services, building the cache:
bun scripts/ingest-from-postgres.ts --uuids-file=data/random-1000-uuids.json --reset

# Re-ingest one service straight from the cache (no Postgres):
bun scripts/ingest-from-postgres.ts --from-cache --services=qdrant --reset
```

### `scripts/performance.ts` — unfiltered latency benchmark

Embeds each query once (shared across services), then times per-collection queries and the
end-to-end "both collections in parallel" path. Reports min/avg/p50/p95/max.

| Flag | Default | Meaning |
|---|---|---|
| `--services=a,b` | `turbopuffer,pinecone` | backends to test (add `,qdrant` to include it) |
| `--topk=N` | `10` | neighbors per query |
| `--iterations=N` | `30` | repeats per query |
| `--consistency=strong\|eventual` | `strong` | Turbopuffer read consistency (Pinecone ignores) |
| `--warm` | off | opt into Turbopuffer `hintCacheWarm` prewarm before measuring |
| `--query="..."` | — | **one-shot mode**: run this single query once per service, print latency / hits / top score |
| `"text" "text"` (positional) | 5 built-in queries | custom queries to benchmark |

```bash
# Full benchmark, defaults (strong consistency, no prewarm):
bun scripts/performance.ts --services=turbopuffer,pinecone,qdrant --topk=50 --iterations=50

# One-shot ad-hoc query:
bun scripts/performance.ts --query="medicaid expansion" --services=turbopuffer,pinecone --topk=10

# A/B the old defaults (prewarmed + eventual):
bun scripts/performance.ts --warm --consistency=eventual --iterations=50
```

### `scripts/performance-filtered.ts` — filtered latency benchmark

Same as above, but every query carries a metadata pre-filter: `session_id` (eq / in) plus a
`notification_action_time_epoch` range. Both are numeric so all backends run an identical filter.
Also prints a hit-count table — a correctness check that all services match.

Shares `--services`, `--topk` (default **20**), `--iterations` (default **50**), `--consistency`
(default `strong`), `--warm`, and positional queries. Filter flags:

| Flag | Default | Meaning |
|---|---|---|
| `--sessions=2176,2244` | `2163` | one or more `session_id`s (eq for one, in for several) |
| `--session=N` | — | single-session alias (back-compat) |
| `--since=YYYY-MM-DD` | `2026-06-10` | lower bound on `notification_action_time` |
| `--until=YYYY-MM-DD` | open | optional upper bound → bounded `since ≤ date ≤ until` window |

```bash
bun scripts/performance-filtered.ts --services=turbopuffer,pinecone,qdrant \
  --sessions=2163 --since=2026-06-10 --topk=50 --iterations=50
```

> Unknown flags are rejected by both benchmarks (typos fail loudly instead of being ignored).

---

## Typical workflow

```bash
# 1. Ingest the eval set into all services (from Postgres, builds the cache)
bun scripts/ingest-from-postgres.ts --uuids-file=data/random-1000-uuids.json --reset

# 2. Benchmark — ideally from an in-region EC2 box (see docs/EC2-BENCHMARK.md)
bun scripts/performance.ts          --services=turbopuffer,pinecone,qdrant --topk=50 --iterations=50
bun scripts/performance-filtered.ts --services=turbopuffer,pinecone,qdrant --topk=50 --iterations=50
```

A laptop benchmark mostly measures your distance to `us-east-1`, not the engines — see
[docs/EC2-BENCHMARK.md](docs/EC2-BENCHMARK.md).
