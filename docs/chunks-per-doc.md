# Turbopuffer corpus profile — chunks & metadata

**Date:** 2026-06-25
**Source:** Turbopuffer namespaces `bill_text` + `bill_amendment` (live data; eventual-consistency snapshot, last write ~2026-06-22)
**Scripts:** `[scripts/chunks-per-doc.ts](../scripts/chunks-per-doc.ts)`, `[scripts/metadata-size.ts](../scripts/metadata-size.ts)`

## 1 · Chunks per `doc_uuid`

A document averages **~8 chunks** — but that average is dominated by a few enormous outliers. The **typical** document has just **1–3 chunks** (the median).


| Namespace        | Chunks (rows) | Distinct `doc_uuid` | **Avg chunks/doc** | Median | Min | Max   |
| ---------------- | ------------- | ------------------- | ------------------ | ------ | --- | ----- |
| `bill_text`      | 1,049,000     | 106,454             | **9.85**           | 3      | 1   | 7,262 |
| `bill_amendment` | 413,299       | 76,176              | **5.43**           | 1      | 1   | 8,411 |
| **Combined**     | 1,462,299     | 182,630             | **8.01**           | 2      | 1   | 8,411 |


**The average is misleading.** The mean sits far above the median in both collections (`bill_amendment` median **1** vs mean **5.43**; `bill_text` median **3** vs mean **9.85**). The distribution is extremely right-skewed: most documents are tiny (1–3 chunks), but a long tail of very large documents — one `bill_text` doc has **7,262** chunks, one `bill_amendment` doc **8,411** — pulls the mean well above any typical document.

> Practical read: a typical doc is **1–3 chunks**; the **~8 average** exists only because of a handful of giant documents.

## 2 · Metadata size per row (excludes vector)

About **~3 kB of metadata per chunk**, in a tight distribution (max ~4.5 kB — no heavy tail, unlike the chunk-*count* distribution above).


| Namespace        | Avg metadata | Median / p95 / max    | Est. namespace total* |
| ---------------- | ------------ | --------------------- | --------------------- |
| `bill_text`      | **3.14 kB**  | 3.17 / 4.00 / 4.52 kB | ~3.2 GB               |
| `bill_amendment` | **3.08 kB**  | 3.27 / 3.86 / 4.32 kB | ~1.2 GB               |
| **Combined**     | **~3.1 kB**  | —                     | **~4.4 GB**           |


 Estimated as avg × row count (1,049,000 / 413,299). Logical JSON size — Turbopuffer's compressed on-disk footprint is smaller.

**What's in those ~3 kB** (avg bytes per row):

- `chunk_text` ≈ **1.7–1.8 kB** — the bulk
- `summary` ≈ **0.8 kB**
- everything else (`s3_url`, `doc_uuid`, `bill_uuid`, dates, flags, `session_id`) ≈ **0.3 kB** combined

So `chunk_text` + `summary` are **~80%** of the metadata payload.

## Method

Each stored row is **one chunk**. `doc_uuid` is *not* a declared, queryable attribute in Turbopuffer — but ingest builds the row `id` as ``${doc_uuid}::${chunk_id}`` (chunk_id 0-based; see `[scripts/ingest-from-postgres.ts](../scripts/ingest-from-postgres.ts)`), so the parent document is the id prefix.

- **Chunks per doc** — exact **full scan**, paging every row ordered by id (`rank_by:["id","asc"]` + `id > cursor`, `top_k` 2000, ids only), extracting the `doc_uuid` prefix and tallying. A full scan was chosen over `group_by`/`aggregate_by`, which cap at a top-k number of groups and would undercount the ~183k distinct docs. Scanned totals matched Turbopuffer's `approx_namespace_size` exactly.
- **Metadata size** — **sampled** 20,000 rows/namespace (`exclude_attributes:["vector"]`), measuring `Buffer.byteLength(JSON.stringify(metadata))` per row, where `metadata` is every stored attribute except the reserved keys `id`, `vector`, `$dist`. Sampling is sufficient because per-chunk text is bounded by the chunker (tight distribution); a full scan isn't needed for the mean.

## Reproduce

```bash
bun scripts/chunks-per-doc.ts                     # chunks/doc — both collections + combined
bun scripts/metadata-size.ts --sample=20000       # metadata bytes/row — both collections
# flags: --collection=bill_text|bill_amendment · --page=N · (metadata) --sample=N
```

## Caveats

- **Live namespace, not the dump.** `bill_amendment` (413,299) matches the `data-ingest-100k-bills` manifest exactly; `bill_text` is **1,049,000** here vs 1,258,883 in that manifest — the live namespace reflects whatever was last ingested.
- **Eventual-consistency snapshot** — counts/sizes reflect writes included as of ~2026-06-22.
- **Chunk counts are exact** (full scan visits every row). **Metadata sizes are a 20k-row sample** per namespace and a **logical JSON byte size**, not Turbopuffer's compressed on-disk footprint (which will be smaller). `id` is excluded from the metadata size (it adds ~40 B/row).

## 3 · Cost estimate (Turbopuffer)

> **Projected: ~$800/mo (realistic) → ~$2,000/mo (conservative).** From Turbopuffer's pricing calculator (vector dim 1,536, priced 2026-06-25). The two scenarios bracket the range.

### Expected write load

The ingestion system generates **~4.1M writes/month**, with a **3× safety factor already applied**. The model reuses the median chunks/doc measured in §1 (`bill_text` 3, `bill_amendment` 1):

```
weeks_per_month = 4
safety factor (fs) = 3
b = 277k bill updates × 20% (properties we care about, e.g. notification_action_time) = 55,400

bill_text       writes = (30,000 + 55,400) × 3 × 4 × 3 = 3,074,400
bill_amendment  writes = (31,000 + 55,400) × 1 × 4 × 3 = 1,036,800
                                          total/month  ≈ 4,111,200
```

This expected load sits **well under** the write volumes both pricing scenarios assume (10M and 50M/mo), so writes are not the binding cost at real volume.

### Scenario A — Tight (realistic)

`4 kB` attributes · `50M` docs · `10M` writes · `10M` queries · **scale** plan


| Component  | Assumption                                   | Cost        |
| ---------- | -------------------------------------------- | ----------- |
| Storage    | 50M docs (~354 GB) @ ≤ $0.33/GB              | $129.89     |
| Writes     | 10M writes, ~~4 WPS (~~101 GB) @ ≤ $2.00/GB  | $109.44     |
| Queries    | 10M queries, ~~4 QPS (~~602 PB) @ ≤ $1.00/PB | $572.24     |
| Namespaces | 50M docs/namespace                           | Included    |
| **Total**  | scale plan (min $256/mo)                     | **$812/mo** |


### Scenario B — Conservative (with safety)

`8 kB` attributes · `100M` docs · `50M` writes · `10M` queries · **launch** plan


| Component  | Assumption                                   | Cost          |
| ---------- | -------------------------------------------- | ------------- |
| Storage    | 100M docs (~1 TB) @ ≤ $0.33/GB               | $418.18       |
| Writes     | 50M writes, ~~20 WPS (~~707 GB) @ ≤ $2.00/GB | $787.20       |
| Queries    | 10M queries, ~~4 QPS (~~904 PB) @ ≤ $1.00/PB | $779.68       |
| Namespaces | 100M docs/namespace                          | Included      |
| **Total**  | launch plan (min $16/mo)                     | **$1,985/mo** |


### Notes

- **Writes and queries are the cost drivers; storage is minor.** In the realistic case queries alone are ~~70% of the bill ($572 of $812). In the conservative case writes and queries are roughly tied (~~$780 each) — only because it assumes 5× the writes (50M).
- **Per-row bytes scale with attribute size.** Each write ships the 1,536-d vector (~~6 kB) + attributes, so the calculator shows ~10 kB/row at 4 kB attrs and ~14 kB at 8 kB. The **measured ~3.1 kB metadata (§2) justifies the 4 kB setting** (~~30% headroom); 8 kB is padding. (Stored size is ~30% lower again due to compression.)
- **Expected load fits comfortably.** ~4.1M writes/mo is ~40% of the tight scenario's 10M assumption — writes aren't the binding constraint at real volume.
- **"docs" = rows = chunks** in the calculator. Today's namespaces hold ~~1.46M chunks (§1); the 50M / 100M figures are forward-looking capacity (~~34× / ~68× current). `≤` rates are per-unit ceilings; component totals are taken directly from the calculator (effective rates are tiered/lower).

