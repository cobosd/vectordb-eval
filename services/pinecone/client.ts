import { Pinecone } from "@pinecone-database/pinecone";
import { PINECONE_API_KEY } from "../../config";

let client: Pinecone | null = null;

/**
 * Lazily-constructed Pinecone client. Constructed on first use (not at import)
 * so selecting only other services doesn't require PINECONE_API_KEY.
 */
export function getPinecone(): Pinecone {
  if (!client) {
    if (!PINECONE_API_KEY) throw new Error("PINECONE_API_KEY is not set");
    client = new Pinecone({ apiKey: PINECONE_API_KEY });
  }
  return client;
}
