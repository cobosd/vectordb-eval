/**
 * Bounded-concurrency write pool.
 *
 * Turbopuffer caps single-namespace write throughput (~200-230 rows/s in
 * practice), and a single in-flight write only reaches ~half that. Keeping a few
 * writes in flight at once roughly doubles throughput before the server-side
 * per-namespace ceiling kicks in. This runs at most `concurrency` tasks
 * concurrently; submit() blocks once the pool is full and resumes as slots free.
 *
 * Fail-fast: if any task rejects, the rejection surfaces from a later submit()
 * (via Promise.race) or from drain(), so a failed write aborts the ingest.
 */
export function createWritePool(concurrency: number) {
  const inflight = new Set<Promise<void>>();
  return {
    /** Start `task`; block first if `concurrency` writes are already in flight. */
    async submit(task: () => Promise<void>): Promise<void> {
      while (inflight.size >= concurrency) await Promise.race(inflight);
      let p: Promise<void>;
      // eslint-disable-next-line prefer-const
      p = task().finally(() => inflight.delete(p));
      inflight.add(p);
    },
    /** Await all outstanding writes. */
    async drain(): Promise<void> {
      await Promise.all(inflight);
    },
  };
}
