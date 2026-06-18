import type { RunConfig, RunMode } from "./types";
import type { Service } from "@/lib/eval-helpers";

const KNOWN_MODES: RunMode[] = ["unfiltered", "filtered"];
const KNOWN_SERVICES: Service[] = ["turbopuffer", "pinecone", "qdrant", "opensearch"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Caps to keep an untrusted POST body from spawning an unbounded sweep.
const CAP = {
  topK: 2000,
  iters: 500,
  queries: 50,
  sessions: 200,
  units: 300, // modes × topKs × iters × services
};

const uniq = <T,>(xs: T[]) => [...new Set(xs)];

function ints(input: unknown, { min, max }: { min: number; max: number }): number[] {
  if (!Array.isArray(input)) return [];
  return uniq(
    input
      .map((v) => Number(v))
      .filter((n) => Number.isInteger(n) && n >= min && n <= max)
  );
}

/**
 * Validate + clamp an untrusted run config. Returns either a normalized config
 * or a human-readable error (→ HTTP 400).
 */
export function normalizeRunConfig(raw: unknown): { config?: RunConfig; error?: string } {
  if (!raw || typeof raw !== "object") return { error: "invalid config body" };
  const r = raw as Record<string, unknown>;

  const modes = uniq((Array.isArray(r.modes) ? r.modes : []).filter(
    (m): m is RunMode => KNOWN_MODES.includes(m as RunMode)
  ));
  if (!modes.length) return { error: "pick at least one mode (unfiltered/filtered)" };

  const services = uniq((Array.isArray(r.services) ? r.services : []).filter(
    (s): s is Service => KNOWN_SERVICES.includes(s as Service)
  ));
  if (!services.length) return { error: "pick at least one known service" };

  const topKs = ints(r.topKs, { min: 1, max: CAP.topK });
  if (!topKs.length) return { error: `topK must be 1–${CAP.topK}` };

  const iters = ints(r.iters, { min: 1, max: CAP.iters });
  if (!iters.length) return { error: `iters must be 1–${CAP.iters}` };

  const units = modes.length * topKs.length * iters.length * services.length;
  if (units > CAP.units) {
    return { error: `too large: ${units} units (max ${CAP.units}); reduce the sweep` };
  }

  const consistency = r.consistency === "strong" ? "strong" : "eventual";
  const warm = r.warm === true;

  const sessions = (Array.isArray(r.sessions) ? r.sessions : [])
    .map((v) => Number(v))
    .filter((n) => Number.isFinite(n))
    .slice(0, CAP.sessions);

  const since = typeof r.since === "string" ? r.since.trim() : "";
  const until = typeof r.until === "string" && r.until.trim() ? r.until.trim() : undefined;

  if (modes.includes("filtered")) {
    if (!sessions.length) return { error: "filtered mode needs at least one session id" };
    if (!DATE_RE.test(since)) return { error: "filtered mode needs a 'since' date (YYYY-MM-DD)" };
    if (until && !DATE_RE.test(until)) return { error: "'until' must be YYYY-MM-DD" };
  }

  let queries: string[] | undefined;
  if (Array.isArray(r.queries)) {
    const q = r.queries
      .filter((s): s is string => typeof s === "string")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, CAP.queries);
    if (q.length) queries = q;
  }

  return {
    config: {
      modes,
      topKs,
      iters,
      services,
      consistency,
      warm,
      sessions,
      since: since || "2026-06-10",
      until,
      ...(queries ? { queries } : {}),
    },
  };
}
