import { createHash } from "node:crypto";

/**
 * Voyage AI client for `voyage-context-3` contextualized chunk embeddings and
 * `rerank-2.5` reranking. Only sanitized, placeholder-tokenized text is ever
 * passed in; the ingress guard has already rejected anything carrying raw PII.
 *
 * When the API key is `"mock"`, a deterministic offline implementation is
 * used instead so local development and CI never need network access.
 */

export const VOYAGE_EMBEDDING_MODEL = "voyage-context-3";
export const VOYAGE_RERANK_MODEL = "rerank-2.5";
export const EMBEDDING_DIMENSIONS = 1024;

const VOYAGE_BASE_URL = "https://api.voyageai.com/v1";

/**
 * Voyage caps each document (inner list) at 32K tokens and a request at 120K
 * tokens. Budgets are in characters at a conservative ~4 chars/token so a
 * dense clinical document stays under both limits.
 */
const MAX_CONTEXT_CHARS = 96_000;
const MAX_REQUEST_CHARS = 360_000;

export type EmbeddingInputType = "document" | "query";

export interface RerankResult {
  /** Index into the `documents` array passed to `rerank()`. */
  index: number;
  relevanceScore: number;
}

export interface VoyageService {
  readonly mode: "live" | "mock";
  readonly embeddingModel: string;
  /**
   * Embeds the chunks of ONE document together, so each vector carries the
   * surrounding document context. Returns one vector per chunk, in order.
   */
  embedDocumentChunks(chunks: readonly string[]): Promise<number[][]>;
  embedQuery(query: string): Promise<number[]>;
  rerank(query: string, documents: readonly string[], topK?: number): Promise<RerankResult[]>;
}

export class VoyageApiError extends Error {
  readonly status: number;

  constructor(endpoint: string, status: number) {
    // The response body is deliberately not included: it is not needed to
    // diagnose a failure and keeps request text out of logs and job records.
    super(`Voyage API ${endpoint} failed with HTTP ${status}`);
    this.name = "VoyageApiError";
    this.status = status;
  }
}

export interface VoyageServiceOptions {
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
  dimensions?: number;
}

export function createVoyageService(options: VoyageServiceOptions): VoyageService {
  const dimensions = options.dimensions ?? EMBEDDING_DIMENSIONS;
  return options.apiKey === "mock"
    ? createMockVoyageService(dimensions)
    : createLiveVoyageService({ ...options, dimensions });
}

// ---------------------------------------------------------------------------
// Live client
// ---------------------------------------------------------------------------

interface ContextualizedEmbeddingsResponse {
  data: Array<{ index: number; data: Array<{ index: number; embedding: number[] }> }>;
}

interface RerankResponse {
  data: Array<{ index: number; relevance_score: number }>;
}

/**
 * Groups consecutive chunks so no group exceeds `maxChars`. A document too
 * large for one context window is embedded as several consecutive windows,
 * each still contextualized over its neighbours.
 */
export function groupByCharBudget(items: readonly string[], maxChars: number): string[][] {
  const groups: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const item of items) {
    if (current.length > 0 && size + item.length > maxChars) {
      groups.push(current);
      current = [];
      size = 0;
    }
    current.push(item);
    size += item.length;
  }
  if (current.length > 0) {
    groups.push(current);
  }
  return groups;
}

function createLiveVoyageService(
  options: VoyageServiceOptions & { dimensions: number },
): VoyageService {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const baseUrl = options.baseUrl ?? VOYAGE_BASE_URL;

  async function post<T>(endpoint: string, body: unknown): Promise<T> {
    const response = await fetchImpl(`${baseUrl}/${endpoint}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new VoyageApiError(endpoint, response.status);
    }
    return (await response.json()) as T;
  }

  async function contextualize(
    inputs: string[][],
    inputType: EmbeddingInputType,
  ): Promise<number[][][]> {
    const response = await post<ContextualizedEmbeddingsResponse>("contextualizedembeddings", {
      model: VOYAGE_EMBEDDING_MODEL,
      inputs,
      input_type: inputType,
      output_dimension: options.dimensions,
    });
    return [...response.data]
      .sort((a, b) => a.index - b.index)
      .map((group) => [...group.data].sort((a, b) => a.index - b.index).map((e) => e.embedding));
  }

  return {
    mode: "live",
    embeddingModel: VOYAGE_EMBEDDING_MODEL,

    async embedDocumentChunks(chunks) {
      if (chunks.length === 0) {
        return [];
      }
      const windows = groupByCharBudget(chunks, MAX_CONTEXT_CHARS);
      const vectors: number[][] = [];
      let request: string[][] = [];
      let requestSize = 0;

      const send = async (): Promise<void> => {
        const groups = await contextualize(request, "document");
        vectors.push(...groups.flat());
        request = [];
        requestSize = 0;
      };

      for (const window of windows) {
        const windowSize = window.reduce((sum, chunk) => sum + chunk.length, 0);
        if (request.length > 0 && requestSize + windowSize > MAX_REQUEST_CHARS) {
          await send();
        }
        request.push(window);
        requestSize += windowSize;
      }
      await send();

      if (vectors.length !== chunks.length) {
        throw new Error(
          `Voyage returned ${vectors.length} embeddings for ${chunks.length} chunks`,
        );
      }
      return vectors;
    },

    async embedQuery(query) {
      const [group] = await contextualize([[query]], "query");
      const vector = group?.[0];
      if (!vector) {
        throw new Error("Voyage returned no embedding for the query");
      }
      return vector;
    },

    async rerank(query, documents, topK) {
      if (documents.length === 0) {
        return [];
      }
      const response = await post<RerankResponse>("rerank", {
        model: VOYAGE_RERANK_MODEL,
        query,
        documents,
        ...(topK === undefined ? {} : { top_k: topK }),
      });
      return response.data.map((item) => ({
        index: item.index,
        relevanceScore: item.relevance_score,
      }));
    },
  };
}

// ---------------------------------------------------------------------------
// Deterministic mock (VOYAGE_API_KEY="mock")
// ---------------------------------------------------------------------------

/** Lowercased word and placeholder-token terms; tokens stay whole so they match exactly. */
function terms(text: string): string[] {
  return text.toLowerCase().match(/\[[a-z_]+_[0-9a-f]{4}\]|[a-z0-9]+/g) ?? [];
}

function normalize(vector: number[]): number[] {
  const norm = Math.hypot(...vector);
  return norm === 0 ? vector : vector.map((value) => value / norm);
}

/**
 * Feature-hashed bag of words: each term adds +-1 to a SHA-256-chosen
 * dimension. Texts sharing vocabulary get high cosine similarity, which is
 * enough for retrieval tests to behave sensibly without a real model.
 */
function hashEmbedding(text: string, dimensions: number): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  for (const term of terms(text)) {
    const digest = createHash("sha256").update(term).digest();
    const slot = digest.readUInt32BE(0) % dimensions;
    vector[slot] = (vector[slot] ?? 0) + ((digest[4] ?? 0) & 1 ? 1 : -1);
  }
  return normalize(vector);
}

/** Weight of the whole-document vector mixed into each chunk vector. */
const MOCK_CONTEXT_WEIGHT = 0.25;

export function createMockVoyageService(dimensions = EMBEDDING_DIMENSIONS): VoyageService {
  return {
    mode: "mock",
    embeddingModel: `${VOYAGE_EMBEDDING_MODEL}-mock`,

    async embedDocumentChunks(chunks) {
      if (chunks.length === 0) {
        return [];
      }
      const documentVector = hashEmbedding(chunks.join("\n"), dimensions);
      return chunks.map((chunk) => {
        const chunkVector = hashEmbedding(chunk, dimensions);
        return normalize(
          chunkVector.map(
            (value, i) =>
              (1 - MOCK_CONTEXT_WEIGHT) * value + MOCK_CONTEXT_WEIGHT * (documentVector[i] ?? 0),
          ),
        );
      });
    },

    async embedQuery(query) {
      return hashEmbedding(query, dimensions);
    },

    async rerank(query, documents, topK) {
      const queryTerms = new Set(terms(query));
      const scored = documents.map((document, index) => {
        const documentTerms = new Set(terms(document));
        let overlap = 0;
        for (const term of queryTerms) {
          if (documentTerms.has(term)) {
            overlap += 1;
          }
        }
        const relevanceScore = queryTerms.size === 0 ? 0 : overlap / queryTerms.size;
        return { index, relevanceScore };
      });
      scored.sort((a, b) => b.relevanceScore - a.relevanceScore || a.index - b.index);
      return topK === undefined ? scored : scored.slice(0, topK);
    },
  };
}
