# Running the benchmarks from EC2 (the only fair latency test)

Latency from a laptop is dominated by the public-internet hop to `aws-us-east-1`
(~35–40ms floor), which swamps the actual engine differences. Running from an EC2
instance **in the same region** removes that hop, so Turbopuffer/Pinecone drop to
low-single-digit ms and you measure the engines, not your ISP.

See [NOTES.md](../NOTES.md) for the why (co-location, BYOC, local-vs-remote fairness).

## 1. Provision

- EC2 instance in **`us-east-1`** (same region as the Pinecone index + Turbopuffer
  region). A `c7i.xlarge` is plenty — you want good single-core + network, not much RAM
  unless you load a lot into local Qdrant.
- The subnet needs **outbound internet** (IGW or NAT). Turbopuffer/Pinecone public
  endpoints are reached over standard AWS networking — no VPN needed. If egress is
  blocked you'll be debugging connectivity instead of measuring latency.
- Install [Bun](https://bun.sh): `curl -fsSL https://bun.sh/install | bash`
- Install Docker (for local Qdrant), if comparing Qdrant.

## 2. Get the code + secrets onto the box

```sh
git clone <repo> && cd vectordb-eval
bun install
# .env is gitignored — copy it up from your machine:
#   scp .env ec2-user@<host>:~/vectordb-eval/.env
# Needs: OPENAI_API_KEY, TURBOPUFFER_API_KEY, PINECONE_API_KEY
```

## 3. (Optional) Local Qdrant on the box

Qdrant's data lives in its local container, so it starts empty and must be ingested
**on the EC2 box**. The vector cache is gitignored, so bring it up first:

```sh
# from your laptop — the cache is ~480MB:
scp -r data/cache ec2-user@<host>:~/vectordb-eval/data/cache
```

```sh
# on the EC2 box:
docker run -d -p 6333:6333 qdrant/qdrant
bun scripts/ingest-from-postgres.ts --from-cache --services=qdrant --reset
```

If you skip Qdrant, just drop it from `--services` below — Turbopuffer vs Pinecone is
the fair managed-vs-managed pair and needs no setup on the box.

> Note: local Qdrant has no network hop *and* no multi-tenant/durability overhead, so it
> will still look fastest. The honest framing is "local self-host vs in-region managed,"
> not a flat ranking. The truly apples-to-apples engine test is all three queried from
> this one box.

## 4. Run

```sh
# Unfiltered latency
bun scripts/performance.ts --services=turbopuffer,pinecone,qdrant --topk=50 --iterations=50

# Filtered latency (session_id + date range)
bun scripts/performance-filtered.ts --services=turbopuffer,pinecone,qdrant --topk=50 --iterations=50
```

Drop `,qdrant` if you didn't set it up:
`--services=turbopuffer,pinecone`

## 5. Reading the results

- **Read the per-collection tables**, not wall-clock-with-embedding. The OpenAI embedding
  call is shared across services and network-bound to OpenAI; once DB latency drops it
  becomes a larger relative chunk, but the per-collection query tables isolate DB latency.
- **Expect Turbopuffer/Pinecone at low-single-digit ms** here (vs ~35–40ms from a laptop).
  If they're still ~35ms, the box isn't actually in-region or traffic is egressing oddly.
- **The filtered run's hit-count table should match across all services** — a correctness
  check that the `session_id` + epoch filter maps identically. If counts are near zero,
  widen `--since` / pick a populated `--session`; it's the sample, not a bug.
