#!/usr/bin/env bash
#
# Run the latency benchmarks (unfiltered + filtered) across a matrix of
# (topK, iterations) combinations, against all services.
#
#   ./run.sh                            # all services, strong consistency, no prewarm
#   ./run.sh --both-consistencies       # run eventual and strong consistency
#   ./run.sh --consistencies=eventual,strong
#   ./run.sh --consistency=eventual     # eventual consistency only (Turbopuffer honors it)
#   ./run.sh --warm                     # enable native cache prewarm
#   SERVICES=turbopuffer,pinecone ./run.sh
#   CONSISTENCY=eventual ./run.sh       # env-var form, equivalent to the flag
#
# Consistency flags are parsed here and threaded into both scripts; any other
# flags (e.g. --warm, --topk overrides) pass straight through.
#
set -euo pipefail
cd "$(dirname "$0")"

SERVICES="${SERVICES:-turbopuffer,pinecone,qdrant,opensearch}"
if [[ -n "${CONSISTENCY:-}" ]]; then
  CONSISTENCIES="$CONSISTENCY"
else
  CONSISTENCIES="${CONSISTENCIES:-strong}"
fi

# Pull consistency flags out of the args (so they aren't also passed twice);
# everything else is forwarded to both benchmark scripts.
PASS_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --both-consistencies) CONSISTENCIES="eventual,strong" ;;
    --consistencies=*) CONSISTENCIES="${arg#--consistencies=}" ;;
    --consistency=*) CONSISTENCIES="${arg#--consistency=}" ;;
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

IFS=',' read -ra CONSISTENCY_LIST <<<"$CONSISTENCIES"

for consistency in "${CONSISTENCY_LIST[@]}"; do
  for combo in "${COMBOS[@]}"; do
    read -r topk iters <<<"$combo"
    echo
    echo "============================================================"
    echo "  topK=$topk  iterations=$iters  consistency=$consistency  services=$SERVICES"
    echo "============================================================"

    echo "--- unfiltered (scripts/performance.ts) ---"
    bun scripts/performance.ts --services="$SERVICES" --topk="$topk" --iterations="$iters" \
      --consistency="$consistency" ${PASS_ARGS[@]+"${PASS_ARGS[@]}"}

    echo "--- filtered (scripts/performance-filtered.ts) ---"
    bun scripts/performance-filtered.ts --services="$SERVICES" --topk="$topk" --iterations="$iters" \
      --consistency="$consistency" ${PASS_ARGS[@]+"${PASS_ARGS[@]}"}
  done
done
