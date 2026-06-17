import { Turbopuffer } from "@turbopuffer/turbopuffer";
import { TURBOPUFFER_API_KEY } from "../../config";

/** Region all stores read/write — co-located with the Pinecone index. */
export const TURBOPUFFER_REGION = "aws-us-east-1"; // https://turbopuffer.com/docs/regions

let client: Turbopuffer | null = null;

/** Build a Turbopuffer client pinned to a specific region (e.g. to reach an old region). */
export function createTurbopufferClient(region: string): Turbopuffer {
  if (!TURBOPUFFER_API_KEY) throw new Error("TURBOPUFFER_API_KEY is not set");
  return new Turbopuffer({ apiKey: TURBOPUFFER_API_KEY, region });
}

/**
 * Lazily-constructed default-region Turbopuffer client. Constructed on first use
 * (not at import) so selecting only other services doesn't require TURBOPUFFER_API_KEY.
 */
export function getTurbopuffer(): Turbopuffer {
  if (!client) client = createTurbopufferClient(TURBOPUFFER_REGION);
  return client;
}
