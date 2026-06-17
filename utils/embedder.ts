import OpenAI from "openai";
import { OPENAI_API_KEY } from "../config";
import { EMBEDDING_DIMENSIONS } from "../consts";

/** Must match the model that produced the stored bill_embedding vectors. */
export const EMBEDDING_MODEL = "text-embedding-3-small";

let client: OpenAI | null = null;

/** Lazily-constructed OpenAI client (only needs the key when first used). */
function getOpenAI(): OpenAI {
  if (!client) {
    if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");
    client = new OpenAI({ apiKey: OPENAI_API_KEY });
  }
  return client;
}

/** Embed a batch of texts (input order is preserved). */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const res = await getOpenAI().embeddings.create({
    model: EMBEDDING_MODEL,
    input: texts,
    dimensions: EMBEDDING_DIMENSIONS,
  });
  return res.data.map((d) => d.embedding);
}

/** Embed a single text into a query vector. */
export async function embed(text: string): Promise<number[]> {
  const [vector] = await embedBatch([text]);
  return vector!;
}
