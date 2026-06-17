import { Client } from "@opensearch-project/opensearch";
import { OPENSEARCH_NODE, OPENSEARCH_USERNAME, OPENSEARCH_PASSWORD } from "../../config";

let client: Client | null = null;

/**
 * Lazily-constructed OpenSearch client. Built on first use (not at import) so
 * selecting only other services doesn't require OPENSEARCH_* env vars. Basic auth
 * is included only when both username and password are set (some clusters are open).
 */
export function getOpenSearch(): Client {
  if (!client) {
    if (!OPENSEARCH_NODE) throw new Error("OPENSEARCH_NODE is not set");
    client = new Client({
      node: OPENSEARCH_NODE,
      ...(OPENSEARCH_USERNAME && OPENSEARCH_PASSWORD
        ? { auth: { username: OPENSEARCH_USERNAME, password: OPENSEARCH_PASSWORD } }
        : {}),
      ssl: { rejectUnauthorized: true },
    });
  }
  return client;
}
