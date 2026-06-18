import "server-only";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import readline from "node:readline";

import { repoRoot } from "@/lib/paths";
import type { RunConfig, RunEvent, RunStatus, RunSummary } from "./types";

interface RunState {
  id: string;
  status: RunStatus;
  config: RunConfig;
  events: RunEvent[];
  totalUnits: number;
  completed: number;
  csvFile?: string;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  child: ChildProcessWithoutNullStreams;
  emitter: EventEmitter;
  timer?: ReturnType<typeof setTimeout>;
}

// Keep state on the global so it survives module re-evaluation in dev.
const g = globalThis as unknown as { __perfRuns?: Map<string, RunState> };
const runs: Map<string, RunState> = (g.__perfRuns ??= new Map());

const MAX_KEPT = 25;
/** Hard ceiling on how many runs may be executing at once. */
export const MAX_CONCURRENT = Math.max(1, Number(process.env.PERF_MAX_CONCURRENT ?? 2));
/** Wall-clock cap per run; a hung child is SIGKILLed and recorded as an error. */
const RUN_TIMEOUT_MS = Math.max(60_000, Number(process.env.PERF_RUN_TIMEOUT_MS ?? 45 * 60_000));

function prune() {
  if (runs.size <= MAX_KEPT) return;
  const finished = [...runs.values()]
    .filter((r) => r.status !== "running")
    .sort((a, b) => (a.finishedAt ?? "").localeCompare(b.finishedAt ?? ""));
  while (runs.size > MAX_KEPT && finished.length) runs.delete(finished.shift()!.id);
}

function finalize(state: RunState, status: "done" | "error") {
  state.status = status;
  state.finishedAt = new Date().toISOString();
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = undefined;
  }
}

function record(state: RunState, ev: RunEvent) {
  state.events.push(ev);
  switch (ev.type) {
    case "run-start":
      state.totalUnits = ev.totalUnits;
      break;
    case "result":
    case "unit-error":
      state.completed = ev.completed;
      break;
    case "run-done":
      state.csvFile = ev.csvFile;
      finalize(state, "done");
      break;
    case "run-error":
      state.error = ev.message;
      finalize(state, "error");
      break;
  }
  state.emitter.emit("event", ev);
}

export function runningCount(): number {
  let n = 0;
  for (const r of runs.values()) if (r.status === "running") n++;
  return n;
}

export function startRun(config: RunConfig): RunSummary {
  const id = randomUUID();
  const child = spawn("bun", ["scripts/run-eval.ts", JSON.stringify(config)], {
    cwd: repoRoot(),
    env: process.env,
  }) as ChildProcessWithoutNullStreams;

  const state: RunState = {
    id,
    status: "running",
    config,
    events: [],
    totalUnits: 0,
    completed: 0,
    startedAt: new Date().toISOString(),
    child,
    emitter: new EventEmitter(),
  };
  state.emitter.setMaxListeners(0);
  runs.set(id, state);
  prune();

  // Bound the run's wall-clock — kill a hung/abandoned child so it can't keep
  // hammering the vector DBs forever.
  state.timer = setTimeout(() => {
    if (state.status === "running") {
      try {
        state.child.kill("SIGKILL");
      } catch {}
      record(state, {
        type: "run-error",
        message: `run timed out after ${Math.round(RUN_TIMEOUT_MS / 1000)}s`,
      });
    }
  }, RUN_TIMEOUT_MS);

  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      record(state, JSON.parse(trimmed) as RunEvent);
    } catch {
      record(state, { type: "log", level: "stdout", message: trimmed });
    }
  });

  readline.createInterface({ input: child.stderr }).on("line", (line) => {
    const trimmed = line.trim();
    if (trimmed) record(state, { type: "log", level: "stderr", message: trimmed });
  });

  child.on("error", (err) => {
    if (state.status === "running") record(state, { type: "run-error", message: String(err) });
  });

  child.on("close", (code) => {
    if (state.status === "running") {
      record(state, {
        type: "run-error",
        message: `runner exited (code ${code ?? "?"}) without completing`,
      });
    }
  });

  return toSummary(state);
}

export function cancel(id: string): boolean {
  const state = runs.get(id);
  if (!state || state.status !== "running") return false;
  try {
    state.child.kill("SIGTERM");
  } catch {}
  record(state, { type: "run-error", message: "run cancelled" });
  return true;
}

function toSummary(s: RunState): RunSummary {
  return {
    id: s.id,
    status: s.status,
    config: s.config,
    totalUnits: s.totalUnits,
    completed: s.completed,
    csvFile: s.csvFile,
    startedAt: s.startedAt,
    finishedAt: s.finishedAt,
    error: s.error,
  };
}

export function getRun(id: string): RunState | undefined {
  return runs.get(id);
}

export function getSummary(id: string): RunSummary | undefined {
  const s = runs.get(id);
  return s ? toSummary(s) : undefined;
}

export function listRuns(): RunSummary[] {
  return [...runs.values()]
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .map(toSummary);
}

/** Subscribe to live events for a run. Returns an unsubscribe fn. */
export function subscribe(id: string, listener: (ev: RunEvent) => void): () => void {
  const state = runs.get(id);
  if (!state) return () => {};
  state.emitter.on("event", listener);
  return () => state.emitter.off("event", listener);
}

/** Buffered events so far (for SSE replay on connect). */
export function bufferedEvents(id: string): RunEvent[] {
  return runs.get(id)?.events ?? [];
}

export function isRunning(id: string): boolean {
  return runs.get(id)?.status === "running";
}
