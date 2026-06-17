import { QdrantClient } from "@qdrant/js-client-rest";
import { QDRANT_API_KEY, QDRANT_URL } from "../../config";

let client: QdrantClient | null = null;

/**
 * Lazily-constructed Qdrant client. Built on first use (not at import) so
 * selecting only other services doesn't require Qdrant to be running. Points at
 * the local Docker instance by default (QDRANT_URL); API key is optional (local
 * Qdrant runs without auth).
 */
export function getQdrant(): QdrantClient {
  if (!client) {
    client = new QdrantClient({
      url: QDRANT_URL,
      ...(QDRANT_API_KEY ? { apiKey: QDRANT_API_KEY } : {}),
    });
  }
  return client;
}
