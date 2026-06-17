#!/usr/bin/env bash
#
# Run the latency benchmarks (unfiltered + filtered) across a matrix of
# (topK, iterations) combinations, against all services.
#
#   ./run.sh                            # all services, strong consistency, no prewarm
#   ./run.sh --consistency=eventual     # eventual consistency (Turbopuffer only honors it)
#   ./run.sh --warm                     # enable native cache prewarm
#   SERVICES=turbopuffer,pinecone ./run.sh
#   CONSISTENCY=eventual ./run.sh       # env-var form, equivalent to the flag
#
# --consistency is parsed here and threaded into both scripts; any other flags
# (e.g. --warm, --topk overrides) pass straight through.
#
set -euo pipefail
cd "$(dirname "$0")"

SERVICES="${SERVICES:-turbopuffer,pinecone,qdrant,opensearch}"
CONSISTENCY="${CONSISTENCY:-strong}"

# Pull --consistency=… out of the args (so it isn't also passed twice); everything
# else is forwarded to both benchmark scripts.
PASS_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --consistency=*) CONSISTENCY="${arg#--consistency=}" ;;
    *) PASS_ARGS+=("$arg") ;;
  esac
done

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
  echo "  topK=$topk  iterations=$iters  consistency=$CONSISTENCY  services=$SERVICES"
  echo "============================================================"

  echo "--- unfiltered (scripts/performance.ts) ---"
  bun scripts/performance.ts --services="$SERVICES" --topk="$topk" --iterations="$iters" \
    --consistency="$CONSISTENCY" ${PASS_ARGS[@]+"${PASS_ARGS[@]}"}

  echo "--- filtered (scripts/performance-filtered.ts) ---"
  bun scripts/performance-filtered.ts --services="$SERVICES" --topk="$topk" --iterations="$iters" \
    --consistency="$CONSISTENCY" ${PASS_ARGS[@]+"${PASS_ARGS[@]}"}
done
