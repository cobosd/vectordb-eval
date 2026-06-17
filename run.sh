#!/usr/bin/env bash
#
# Run the latency benchmarks (unfiltered + filtered) across a matrix of
# (topK, iterations) combinations, against all services.
#
#   ./run.sh                      # all services, default consistency (strong), no prewarm
#   SERVICES=turbopuffer,pinecone ./run.sh
#   ./run.sh --warm --consistency=eventual   # extra flags are passed through to both scripts
#
set -euo pipefail
cd "$(dirname "$0")"

SERVICES="${SERVICES:-turbopuffer,pinecone,qdrant}"

# (topK iterations) pairs to sweep.
COMBOS=(
  "5 5"
  "5 50"
  "10 5"
  "10 50"
  "50 5"
  "50 50"
)

for combo in "${COMBOS[@]}"; do
  read -r topk iters <<<"$combo"
  echo
  echo "============================================================"
  echo "  topK=$topk  iterations=$iters  services=$SERVICES"
  echo "============================================================"

  echo "--- unfiltered (scripts/performance.ts) ---"
  bun scripts/performance.ts --services="$SERVICES" --topk="$topk" --iterations="$iters" "$@"

  echo "--- filtered (scripts/performance-filtered.ts) ---"
  bun scripts/performance-filtered.ts --services="$SERVICES" --topk="$topk" --iterations="$iters" "$@"
done
