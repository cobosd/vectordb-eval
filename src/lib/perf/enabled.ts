/**
 * Whether triggering perf runs is allowed in this environment. Runs spawn a Bun
 * process that hits the vector DBs and writes evals/csv/ — only possible when
 * self-hosted (local / in-region EC2), never on Vercel (read-only, no DB access).
 *
 * Override with PERF_RUNS=1 (force on) or PERF_RUNS=0 (force off).
 */
export function runsEnabled(): boolean {
  if (process.env.PERF_RUNS === "1") return true;
  if (process.env.PERF_RUNS === "0") return false;
  return !process.env.VERCEL;
}
