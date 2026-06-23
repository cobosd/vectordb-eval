import { Turbopuffer } from "@turbopuffer/turbopuffer";
import { TURBOPUFFER_API_KEY } from "../../config";

/** Region all stores read/write — co-located with the Pinecone index. */
export const TURBOPUFFER_REGION = "aws-us-east-1"; // https://turbopuffer.com/docs/regions

// TPUF_DEBUG=1 logs every underlying HTTP attempt (status + latency, flags 429s and
// timeouts). This reveals the SDK's *silent* retries/back-off — a single write() that
// returns in 60s might actually be a 60s timeout + a retry under the hood.
const TPUF_DEBUG = process.env.TPUF_DEBUG === "1";

/**
 * Wraps fetch to log each HTTP attempt to stderr. Multiple lines for one logical
 * write() = the SDK retried (rate-limit/timeout). Written straight to stderr so it
 * shows even when the ingest progress bar has silenced winston.
 */
const debugFetch: typeof fetch = async (input, init) => {
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
  let path = rawUrl;
  try {
    path = new URL(rawUrl).pathname;
  } catch {}
  const start = Date.now();
  try {
    const res = await fetch(input as Parameters<typeof fetch>[0], init);
    const ms = Date.now() - start;
    const flag =
      res.status === 429
        ? ` RATE-LIMITED retry-after=${res.headers.get("retry-after") ?? "?"}`
        : res.status >= 400
          ? " ERR"
          : "";
    process.stderr.write(`[tpuf] ${method} ${path} -> ${res.status} ${ms}ms${flag}\n`);
    return res;
  } catch (err) {
    const ms = Date.now() - start;
    process.stderr.write(`[tpuf] ${method} ${path} -> THREW after ${ms}ms: ${err instanceof Error ? err.message : String(err)}\n`);
    throw err;
  }
};

let client: Turbopuffer | null = null;

/** Build a Turbopuffer client pinned to a specific region (e.g. to reach an old region). */
export function createTurbopufferClient(region: string): Turbopuffer {
  if (!TURBOPUFFER_API_KEY) throw new Error("TURBOPUFFER_API_KEY is not set");
  return new Turbopuffer({
    apiKey: TURBOPUFFER_API_KEY,
    region,
    ...(TPUF_DEBUG ? { fetch: debugFetch } : {}),
  });
}

/**
 * Lazily-constructed default-region Turbopuffer client. Constructed on first use
 * (not at import) so selecting only other services doesn't require TURBOPUFFER_API_KEY.
 */
export function getTurbopuffer(): Turbopuffer {
  if (!client) client = createTurbopufferClient(TURBOPUFFER_REGION);
  return client;
}
