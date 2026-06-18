# Service capabilities & limitations

Running notes on what each vector DB can and can't do, learned while building this
eval harness. Facts here are things we verified against the SDKs / live services,
not just docs.

---

## ⚠️ Disclaimer: read the latency numbers carefully

The benchmark results (`evals/*.md`, `scripts/performance*.ts`) are **not a clean
engine-vs-engine comparison**. The services are in **different deployment classes**, and
that — not the search engine — drives most of the latency differences. Treat the numbers as
"how fast is *this service in this configuration* from *this client*," not "which engine is
fastest."

Specific things that skew the comparison:

- **Network proximity dominates at this scale.** Our dataset is small (~41k vectors), so
  queries are mostly network + per-request overhead, not ANN compute. Whoever is closest on
  the wire wins. From the in-region EC2:
  - **OpenSearch** is a private endpoint in the **same VPC and AZ** → shortest path (~sub-ms
    RTT), so it looks fastest.
  - **Turbopuffer / Pinecone / Qdrant Cloud** are reached over **public** (in-region) endpoints
    → more hops, even though traffic stays on the AWS backbone.
  - From a **laptop**, all of the public ones add a ~35–40ms internet hop that has nothing to
    do with the engine.
- **Dedicated vs multi-tenant.** Our OpenSearch domain is a dedicated single node serving only
  this workload; the managed services are multi-tenant (noisy-neighbor variance, extra routing
  layers — visible in their worse tail latencies, e.g. Pinecone max spikes into the hundreds–
  thousands of ms).
- **Consistency setting isn't symmetric.** The benchmarks default to `--consistency=strong`,
  which only Turbopuffer honors (an object-storage round-trip per query); Pinecone/Qdrant/
  OpenSearch are effectively eventual. So Turbopuffer is handicapped unless you pass
  `--consistency=eventual`.
- **Prewarm is off by default** (`--warm` to enable), so first-query cold-cache effects (esp.
  Qdrant Cloud's ~50ms cold-segment plateau) inflate averages.
- **Small, in-RAM dataset.** Engine/index differences (HNSW tuning, filtering strategy) barely
  show until production scale (millions of vectors), where ANN compute starts to dominate.

**For a fair engine comparison:** put everything in the same deployment class (all in-VPC — TP/
Pinecone BYOC, self-hosted Qdrant/OpenSearch), compare **server-reported** compute time
(OpenSearch `took`, Turbopuffer `server_total_ms`) to cancel the network term, and test at
realistic scale. See [docs/EC2-BENCHMARK.md](docs/EC2-BENCHMARK.md).

---

## Turbopuffer

### Deployment
- **Managed SaaS or BYOC** — no downloadable open-source self-host (unlike Qdrant). BYOC
  installs Turbopuffer's software into *your* AWS/GCP/Azure: it runs in your Kubernetes cluster
  and talks directly to your object storage (S3/GCS), while the Turbopuffer team manages/patches
  it remotely via a control plane. Keeps data residency in your network (CMEK, private
  networking), bypasses markup pricing (uses your cloud volume discounts), and — like
  co-locating — removes the public-internet hop. Enterprise: ~$4,096/mo + usage premium.
- **Matching OpenSearch's in-VPC latency:** BYOC is the way to get Turbopuffer into the same
  private-networking class as our in-VPC OpenSearch domain — pods run in your VPC (schedule them
  in the same AZ as the app; cross-AZ is only ~0.5–1ms anyway), so there's no public hop. Caveat:
  even in-VPC, Turbopuffer is **object-storage-backed (S3) with NVMe/RAM cache tiers**, not a
  dedicated node holding the whole index in RAM like the OpenSearch domain. So **warm** (cache-hit)
  queries are comparable, but **cold** queries fetch from regional S3 and are slower — `warm()` /
  `hintCacheWarm()` matters much more here than for an always-resident OpenSearch node.
- **PrivateLink (lighter option):** a private endpoint in your VPC routing to *managed* Turbopuffer
  keeps traffic off the public internet, but compute still lives in Turbopuffer's account/region
  (cross-account, not co-located) — marginal latency gain over the in-region public endpoint;
  its value is security/compliance. You **cannot** put managed (non-BYOC) Turbopuffer in your VPC.

### Capabilities
- **Native cache prewarm**: `namespace.hintCacheWarm()` warms a namespace deterministically
  (cold p50 ~874ms → warm ~14ms). Exposed as `store.warm()`.
- **Tunable read consistency**: `consistency: { level: "strong" | "eventual" }` per query.
  We default to **eventual** — avoids the object-storage round-trip strong consistency
  pays, and matches Pinecone's model for a fair comparison.
- **Date / string fields are filterable directly** — but range ops on a string date are
  lexicographic, so we still index a numeric epoch for true range filtering (see below).
- **Region-pinned**: region lives in the baseURL (`https://{region}.turbopuffer.com`).
  Co-located in `aws-us-east-1` with our backend.
- **Returns only what you ask for**: `exclude_attributes: ["vector"]` keeps the 1536-dim
  vector (~20KB/row) out of responses — major latency win.
- **Filter syntax**: tuple form `[field, "Eq"|"Gt"|"Gte"|"Lt"|"Lte"|"In", value]`, combined
  with `["And", [...]]`.
- **Metadata-only patch**: `write({ patch_by_filter: { filters, patch } })` updates fields
  without re-uploading vectors. No tight rate limit (unlike Pinecone).
- **Per-request size limit: 512MB.**

### Limitations / gotchas
- Eventual consistency searches ≤128MiB of unindexed writes; >99.8% consistent. Only past
  128MiB outstanding do you risk ~1hr staleness.
- Cold cache is dramatically slower than warm — prewarm matters for latency-sensitive paths.
- FTS/BM25 indexes cost ingest time + storage; we dropped them (vector-only schema) since
  every query is pure ANN.

---

## Pinecone

### Deployment
- **Fully managed first** — there's no downloadable production database you run/own (unlike
  Qdrant). But two non-default options exist:
  - **BYOC (Bring Your Own Cloud)**: Pinecone deploys a private region *inside your own
    AWS/GCP/Azure VPC*. Enterprise tier; zero-access model (Pinecone still operates it, no
    SSH/binary), but vectors + queries never leave your VPC. Satisfies data-residency reviews,
    and — like co-locating — removes the public-internet hop, so it cuts latency to in-region RTT.
  - **Pinecone Local**: a Docker in-memory *emulator* for prototyping/CI only. Not
    production-scale; its latency isn't representative.

### Capabilities
- **Serverless, always eventually consistent** — no consistency knob; never pays a
  strong-consistency round-trip.
- **Metadata-filtered queries**: Mongo-style `{ field: { $eq | $gt | $gte | $lt | $lte | $in } }`,
  combined with `{ $and: [...] }`.
- **Bulk metadata update by filter**: `index.update({ filter, metadata })` — but rate-limited
  (see below).
- **Update by vector ID** has a much higher rate limit than update-by-filter.

### Limitations / gotchas
- **Always returns all metadata** — there's no way to trim the metadata payload server-side.
  Large metadata (170KB at topK=50) measurably slows queries (~76ms → ~208ms in our probe).
- **No date type** — range operators (`$gt` etc.) work on **numbers only, not strings**. So a
  date range requires a numeric epoch field (`notification_action_time_epoch`, ms).
- **Update-by-metadata-filter limited to 5 requests/sec per namespace** → HTTP 429. High
  concurrency on `index.update({ filter })` will trip this fast. (This is why a full reindex
  is preferable to backfilling the epoch via metadata patch.)
- **~2MB per upsert request** → ~100–220 records of 1536-dim + metadata per batch
  (`UPSERT_BATCH = 100` in `PineconeStore`).
- **No native cache prewarm** — no SDK/API endpoint to warm a namespace; first query
  absorbs serverless cold-start, so we prime with a throwaway query.
- `PineconeNotFoundError` exposes `.name` but not `.status` (caught both ways in `reset()`).

---

## Qdrant

### Deployment
- **Genuinely self-hostable open-source** — the key differentiator: you run the *actual engine*
  via Docker (`docker run -p 6333:6333 qdrant/qdrant`), a single binary, or Kubernetes/Helm,
  fully on your own infra (on-prem, your VPC, air-gapped). Data never leaves your environment.
  Contrast: Pinecone's and Turbopuffer's BYOC are *managed-in-your-VPC* (their software runs in
  your cloud, but their team operates it and you don't get the binary) — so Qdrant is the only
  one where you own *and operate* the software yourself.
- **Also offered as Qdrant Cloud** (managed SaaS) if you'd rather not run it — so it spans the
  full range from "your box" to "their box," unlike the other two.
- We run it locally (Docker `localhost:6333`) for this eval, which makes it the
  apples-to-oranges entry: no managed/serverless overhead **and no network round-trip**, so its
  latencies aren't directly comparable to the in-region remote services (see Shared notes).
- **Web UI** at `localhost:6333/dashboard` for eyeballing data.

### Capabilities
- **Cosine score is already similarity** (higher = more similar) — no conversion needed.
- **Rich filter syntax**: `must`/`should`/`must_not`, `match` (eq / `any` for in), and
  `range` (gt/gte/lt/lte). Maps cleanly onto our normalized filter.
- **Drops the vector from responses** with `with_vector: false` (and `with_payload: true`
  returns all payload).
- **Cheap reset**: drop + recreate the collection (with indexes) rather than mass-delete.
- **Large upserts OK** — no hard per-request cap like Pinecone's ~2MB; we still batch (500).

### Limitations / gotchas
- **Point IDs must be unsigned ints or UUIDs** — arbitrary strings are rejected. Our IDs are
  composite (`doc_uuid::chunk_id`), so we map each to a deterministic UUIDv5 and stash the
  original under the `__row_id` payload key to return verbatim.
- **Filtering wants payload indexes** to be fast — unindexed filters work but are slow on real
  datasets. We create integer indexes on `session_id` + `notification_action_time_epoch` in
  `ensure()`. (Turbopuffer auto-indexes filterable attrs; Pinecone indexes all metadata.)
- **No native cache prewarm** — like Pinecone, no warm endpoint.
- **No tunable read consistency** in the Turbopuffer sense; the `consistency` param is about
  replica quorum in distributed setups (irrelevant single-node).

---

## OpenSearch

### Deployment
- **Open-source (Apache 2.0), so self-hostable like Qdrant** — run the actual engine
  yourself (Docker / k8s / EC2), or use **AWS OpenSearch Service** (a managed domain). It
  spans the full range from "your box" to "their box."
- We run a **managed AWS OpenSearch Service domain placed *inside our VPC*** (private
  endpoint, `OPENSEARCH_NODE`; basic auth optional via `OPENSEARCH_USERNAME`/`PASSWORD`).
  Because it sits in the **same VPC/AZ** as the EC2 client, it has the shortest network path
  of any service here (~sub-ms RTT) — which is why it looks fastest in the eval. The flip
  side: it is **not reachable from a laptop or from Vercel** — you must be in-VPC
  (EC2 / bastion / VPN). That's why it's **excluded from the app-triggered (`/run`) analysis**,
  which only targets the publicly reachable in-region services.
- Unlike the object-storage-backed engines, our domain is a **dedicated node holding the whole
  index in RAM / OS page cache** — effectively always warm, so cold-start matters far less.

### Capabilities
- **`knn_vector` field, HNSW, cosine** (`space_type: cosinesimil`) on the **Lucene engine**
  specifically (`engine: lucene`, `ef_construction: 128`, `m: 16`) — chosen because Lucene
  supports **efficient filtering *inside* the k-NN query** (pre-filtered ANN), unlike some of
  the other engine options.
- **Filtered k-NN maps cleanly** onto our normalized filter: `eq → term`, `in → terms`,
  `gt/gte/lt/lte → range`, ANDed in a `bool.filter` passed as the knn query's `filter`.
  `session_id` + `notification_action_time_epoch` are mapped as `long` so term/range work;
  other metadata is dynamically mapped.
- **`date_detection: false`** on the index — bill date strings are inconsistent (empty values
  appear) and would clash if auto-mapped as `date`; we filter on the numeric epoch instead.
- **Drops the vector from responses** via `_source.excludes: ["vector"]` — the same
  payload-trimming win as Turbopuffer/Qdrant (Pinecone can't do this).
- **Score normalization**: `cosinesimil` reports `(1 + cosine) / 2`; we recover true cosine
  (`2 * score − 1`) so scores are comparable with the other backends.
- **Bulk upserts** (batched at 500) with no hard per-request size cap like Pinecone's ~2MB;
  **reset = drop + recreate** the index (with mapping) rather than delete-by-query.

### Limitations / gotchas
- **No tunable read consistency** like Turbopuffer's. OpenSearch is near-real-time: a freshly
  indexed doc isn't searchable until the next **refresh (~1s default)** — effectively eventual.
  Fine for this static dataset.
- **No native cache-prewarm endpoint** (no `hintCacheWarm` equivalent). It compensates by being
  a resident in-RAM node, but watch the **occasional tail outlier** — managed-domain GC /
  segment-merge noise (we saw one ~1310ms `max` at topK=5/iters=50 against otherwise sub-15ms
  numbers).
- **Private-VPC reachability is the operational catch** — excellent latency in-region, but no
  access from outside the VPC, which is exactly what keeps it out of the hosted dashboard's run
  path.
- **Engine choice matters**: filtered k-NN here needs the Lucene engine; the faiss/nmslib
  engines have historically had filtering constraints. If self-hosting, that's on you to get
  right.
- **Self-host = self-operate** (upgrades, scaling, snapshots, monitoring); the AWS-managed
  domain trades that for instance-hour pricing.

---

## Deployment cost (rough)

Order-of-magnitude only — BYOC pricing is enterprise/negotiated and changes; verify with sales
before relying on it. "Self-host" is the only one with a $0 software floor, but it trades
license cost for engineering/ops time (the real cost).

| Option | Software / license | Infra (your cloud) | Ops burden | Known $ floor |
|---|---|---|---|---|
| **Turbopuffer BYOC** | Enterprise contract | your S3/GCS + K8s compute (your volume discounts, no markup) | vendor patches/manages remotely | **~$4,096/mo** + usage premium *(stated)* |
| **Pinecone BYOC** | Enterprise tier, custom | your AWS/GCP/Azure region | vendor-managed, zero-access | not publicly listed — negotiated *(est. several $k/mo+)* |
| **Qdrant self-host** | $0 (Apache 2.0, open source) | just the VM/disk you run it on (e.g. ~$50–500/mo for a single node, scales with data) | **all yours** — upgrades, scaling, backups, monitoring | **$0 software**; cost ≈ infra + engineer time |
| **OpenSearch (AWS managed)** | $0 (Apache 2.0) — pay for the managed service, not a license | AWS OpenSearch Service instance-hours + EBS (e.g. ~$100–700/mo per node, scales with size) | AWS runs the cluster; you size/patch/snapshot via console | **$0 software**; cost ≈ node-hours + storage |
| **OpenSearch self-host** | $0 (Apache 2.0) | the VM/disk you run it on | **all yours** | **$0 software**; cost ≈ infra + engineer time |

Notes:
- Turbopuffer's ~$4,096/mo is the only vendor-published BYOC figure here; Pinecone BYOC is
  quote-only. Both are *on top of* your own cloud bill.
- Qdrant's headline "free" is real for the software, but budget meaningful eng time for ops —
  that's the line item BYOC is buying away.
- OpenSearch (and Qdrant) are the open-source options: no license floor, and the AWS-managed
  OpenSearch domain is the in-VPC analogue of BYOC — your network, AWS-operated — which is what
  gave it the in-region latency edge in this eval.
- Managed SaaS (non-BYOC) tiers of Turbopuffer/Pinecone are usage-priced and cheaper to start;
  this table is specifically the in-your-cloud (BYOC) vs own-the-software (self-host) comparison.

---

## Shared / harness conventions
- Embeddings: OpenAI `text-embedding-3-small`, 1536 dims, f32.
- Both services co-located in `aws-us-east-1`; vectors excluded from responses; full metadata
  returned on both for parity.
- Numeric `notification_action_time_epoch` exists on both so date-range filtering is identical
  across services (Pinecone can't range a string date).
- Row cache: `data/cache/<collection>.vectors.jsonl` stores fully-assembled rows (id + vector
  as base64 Float32 + metadata) so re-ingest can replay from disk instead of Postgres.
