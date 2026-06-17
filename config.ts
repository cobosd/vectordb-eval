/**
 * Environment-backed configuration. Bun loads `.env` automatically, so these
 * just surface the relevant variables as typed exports for the rest of the app.
 */

export const OPENSEARCH_NODE = process.env.OPENSEARCH_NODE;
export const OPENSEARCH_USERNAME = process.env.OPENSEARCH_USERNAME;
export const OPENSEARCH_PASSWORD = process.env.OPENSEARCH_PASSWORD;

export const TURBOPUFFER_API_KEY = process.env.TURBOPUFFER_API_KEY;
export const TURBOPUFFER_NAMESPACE = process.env.TURBOPUFFER_NAMESPACE;

export const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

export const PINECONE_API_KEY = process.env.PINECONE_API_KEY;

/** Qdrant REST endpoint. Defaults to a local Docker instance. */
export const QDRANT_URL = process.env.QDRANT_URL ?? "http://localhost:6333";
export const QDRANT_API_KEY = process.env.QDRANT_API_KEY;