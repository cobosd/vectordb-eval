import type { Service } from "@/lib/eval-helpers";

// All filter modes that can appear in a CSV. The combined "filtered" is produced
// by the dashboard orchestrator and run.sh's --filter=both; the split kinds are
// produced by run.sh's per-predicate filtered passes (--filter=session|time).
export type RunMode = "unfiltered" | "filtered" | "filtered-session" | "filtered-time";
export type RunConsistency = "strong" | "eventual";

/** Config sent from the UI to start a benchmark sweep. */
export interface RunConfig {
  modes: RunMode[];
  topKs: number[];
  iters: number[];
  services: Service[];
  consistency: RunConsistency;
  warm: boolean;
  sessions: number[];
  since: string;
  until?: string;
  queries?: string[];
}

export interface RunUnit {
  mode: RunMode;
  topK: number;
  iters: number;
  service: Service;
}

/** A finished measurement row, shape shared by the JSONL `result` event and the CSV file. */
export interface RunResultRow {
  run_at: string;
  mode: RunMode;
  topK: number;
  iters: number;
  service: Service;
  consistency: RunConsistency;
  avg_ms: number;
  p50_ms: number;
  p95_ms: number;
  max_ms: number;
  min_ms: number;
  calls: number;
  queries: number;
  sessions: string;
  since: string;
  until: string;
  warm: boolean;
}

/** Streaming events emitted by scripts/run-eval.ts (one JSON object per stdout line). */
export type RunEvent =
  | { type: "run-start"; runAt: string; config: RunConfig; units: RunUnit[]; totalUnits: number }
  | { type: "embed"; ms: number; queries: number }
  | { type: "unit-start"; mode: RunMode; topK: number; iters: number; service: Service }
  | {
      type: "tick";
      mode: RunMode;
      topK: number;
      iters: number;
      service: Service;
      done: number;
      total: number;
    }
  | { type: "result"; row: RunResultRow; completed: number; totalUnits: number }
  | {
      type: "unit-error";
      mode: RunMode;
      topK: number;
      iters: number;
      service: Service;
      message: string;
      completed: number;
      totalUnits: number;
    }
  | { type: "run-done"; csvFile: string; csvPath: string; rows: number; failed?: number }
  | { type: "run-error"; message: string }
  | { type: "log"; level: string; message: string };

export type RunStatus = "running" | "done" | "error";

export interface RunSummary {
  id: string;
  status: RunStatus;
  config: RunConfig;
  totalUnits: number;
  completed: number;
  csvFile?: string;
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

export const unitKey = (u: {
  mode: string;
  topK: number;
  iters: number;
  service: string;
}): string => `${u.mode}|${u.topK}|${u.iters}|${u.service}`;
