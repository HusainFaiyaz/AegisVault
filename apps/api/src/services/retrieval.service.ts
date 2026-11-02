import { performance } from "node:perf_hooks";
import type { Collection, Document } from "mongodb";
import { detectRawPiiLeakage } from "@aegis/shared";
import {
  DOCUMENT_CHUNKS_SEARCH_INDEX,
  DOCUMENT_CHUNKS_VECTOR_INDEX,
  type DocumentChunkDoc,
} from "../models/document-chunk.model.js";
import { VOYAGE_RERANK_MODEL, type VoyageService } from "./voyage.service.js";

/**
 * Hybrid retrieval over sanitized document chunks.
 *
 * 1. The (already placeholder-tokenized) query is embedded with
 *    `voyage-context-3`.
 * 2. MongoDB's native `$rankFusion` stage runs two ranked sub-pipelines and
 *    merges them with weighted Reciprocal Rank Fusion:
 *    - `vectorPipeline`: `$vectorSearch` over `embedding`, so paraphrases and
 *      clinical synonyms match semantically;
 *    - `fullTextPipeline`: Atlas Search BM25 `$search` over `sanitizedContent`
 *      and `sectionTitle`, plus an exact `in` match on `placeholderTokens`,
 *      so an opaque identifier like `[MRN_3F90]` or an ISO/ICD code, which
 *      carries no semantic signal, still ranks first.
 * 3. The top 25 fused candidates go through Voyage `rerank-2.5`, and the 5
 *    most relevant chunks are returned with full `scoreDetails`.
 *
 * Deployments older than MongoDB 8.1 (e.g. the `atlas-local:8.0` image in
 * docker-compose) reject `$rankFusion`; in `"auto"` mode the service then runs
 * both sub-pipelines itself and applies the same RRF formula client-side.
 */

export const VECTOR_PIPELINE = "vectorPipeline";
export const FULL_TEXT_PIPELINE = "fullTextPipeline";
export type FusionPipelineName = typeof VECTOR_PIPELINE | typeof FULL_TEXT_PIPELINE;

/** Fused candidates handed to the reranker. */
export const DEFAULT_RERANK_CANDIDATES = 25;
/** Chunks returned to the caller after reranking. */
export const DEFAULT_TOP_K = 5;
/** Smoothing constant MongoDB uses in `$rankFusion`'s RRF formula. */
export const RRF_K = 60;
export const MAX_QUERY_CHARS = 4_000;

/** MongoDB error code for "Unrecognized pipeline stage name". */
const UNRECOGNIZED_STAGE_CODE = 40324;

const PLACEHOLDER_TOKEN_PATTERN =
  /\[(?:PER|ORG|LOC|SSN|MRN|IBAN|EMAIL|PHONE|CREDIT_CARD)_[0-9A-F]{4}\]/gi;

/** Fields returned for every candidate; the 1024-d `embedding` is never pulled back. */
const CHUNK_PROJECTION = {
  _id: 1,
  documentId: 1,
  fileName: 1,
  chunkIndex: 1,
  sectionTitle: 1,
  sanitizedContent: 1,
  placeholderTokens: 1,
} as const;

export type FusionMode = "auto" | "native" | "client";
export type FusionSource = "native" | "client";

export interface FusionWeights {
  vectorPipeline: number;
  fullTextPipeline: number;
}

export interface RetrievalOptions {
  /** Restrict retrieval to these documents (e.g. the caller's workspace). */
  documentIds?: readonly string[];
}

export interface PipelineContribution {
  /** 1-based rank within that sub-pipeline. */
  rank: number;
  weight: number;
  /** Raw `vectorSearchScore` / `searchScore`, when the server reports it. */
  score: number | null;
}

export interface RetrievalScoreDetails {
  fusion: {
    method: "reciprocalRankFusion";
    source: FusionSource;
    /** Weighted RRF score: sum of weight / (60 + rank) over contributing pipelines. */
    score: number;
    /** 1-based position among the fused candidates. */
    rank: number;
    pipelines: Record<FusionPipelineName, PipelineContribution | null>;
  };
  rerank: {
    model: string;
    relevanceScore: number;
    /** 1-based position after reranking. */
    rank: number;
  };
}

export interface RetrievedChunk {
  chunkId: string;
  documentId: string;
  fileName: string;
  chunkIndex: number;
  sectionTitle: string;
  sanitizedContent: string;
  placeholderTokens: string[];
  /** `[CIT-01]`..`[CIT-05]`, in reranked order. */
  citationMarker: string;
  /** Rerank relevance clamped to [0, 1] (the `CitationChunk.score` contract). */
  score: number;
  scoreDetails: RetrievalScoreDetails;
}

export interface RetrievalResult {
  chunks: RetrievedChunk[];
  fusionSource: FusionSource;
  /** Number of fused candidates sent to the reranker. */
  candidateCount: number;
  timings: { embedMs: number; fusionMs: number; rerankMs: number; totalMs: number };
}

export interface RetrievalService {
  retrieve(query: string, options?: RetrievalOptions): Promise<RetrievalResult>;
}

/** Minimal aggregation port so the service can run against a fake in tests. */
export interface ChunkAggregator {
  aggregate(pipeline: Document[]): Promise<Document[]>;
}

export function createCollectionAggregator(collection: Collection<DocumentChunkDoc>): ChunkAggregator {
  return {
    aggregate: (pipeline) => collection.aggregate<Document>(pipeline).toArray(),
  };
}

export class RetrievalRejectedError extends Error {
  readonly code = "ZERO_TRUST_VIOLATION";

  constructor(categories: readonly string[]) {
    // Categories only: the offending raw value is never echoed.
    super(`Retrieval query contains unredacted ${categories.join(", ")}`);
    this.name = "RetrievalRejectedError";
  }
}

export interface RetrievalServiceConfig {
  aggregator: ChunkAggregator;
  voyage: VoyageService;
  fusionMode?: FusionMode;
  weights?: Partial<FusionWeights>;
  rerankCandidates?: number;
  topK?: number;
  /** `$vectorSearch` ANN candidates; defaults to 10x the per-pipeline limit. */
  numCandidates?: number;
  vectorIndex?: string;
  searchIndex?: string;
}

// ---------------------------------------------------------------------------
// Pipeline builders (pure)
// ---------------------------------------------------------------------------

export interface PipelineParams {
  query: string;
  queryVector: readonly number[];
  documentIds?: readonly string[];
  /** Results each sub-pipeline contributes before fusion. */
  limit: number;
  numCandidates: number;
  vectorIndex?: string;
  searchIndex?: string;
}

/** Placeholder tokens in the query, normalized to their stored upper-case form. */
export function extractQueryTokens(query: string): string[] {
  return [...new Set((query.match(PLACEHOLDER_TOKEN_PATTERN) ?? []).map((t) => t.toUpperCase()))];
}

export function buildVectorSearchStage(params: PipelineParams): Document {
  return {
    $vectorSearch: {
      index: params.vectorIndex ?? DOCUMENT_CHUNKS_VECTOR_INDEX,
      path: "embedding",
      queryVector: [...params.queryVector],
      numCandidates: params.numCandidates,
      limit: params.limit,
      ...(params.documentIds && params.documentIds.length > 0
        ? { filter: { documentId: { $in: [...params.documentIds] } } }
        : {}),
    },
  };
}

/**
 * BM25 lexical stage. Section titles are boosted over body text, and any
 * placeholder token in the query is matched exactly against the
 * `placeholderTokens` token field, so `[MRN_3F90]` never fuzzily matches
 * `[MRN_3F91]` and always outranks prose that merely mentions "MRN".
 */
export function buildFullTextSearchStage(params: PipelineParams): Document {
  const tokens = extractQueryTokens(params.query);
  const should: Document[] = [
    { text: { query: params.query, path: "sanitizedContent", score: { boost: { value: 1 } } } },
    { text: { query: params.query, path: "sectionTitle", score: { boost: { value: 2 } } } },
  ];
  if (tokens.length > 0) {
    should.push({
      in: { path: "placeholderTokens", value: tokens, score: { boost: { value: 5 } } },
    });
  }
  return {
    $search: {
      index: params.searchIndex ?? DOCUMENT_CHUNKS_SEARCH_INDEX,
      compound: {
        should,
        minimumShouldMatch: 1,
        ...(params.documentIds && params.documentIds.length > 0
          ? { filter: [{ in: { path: "documentId", value: [...params.documentIds] } }] }
          : {}),
      },
    },
  };
}

/** Native MongoDB 8.1+ hybrid pipeline: `$rankFusion` -> top N -> projection with `scoreDetails`. */
export function buildRankFusionPipeline(
  params: PipelineParams & { weights: FusionWeights; fusedLimit: number },
): Document[] {
  return [
    {
      $rankFusion: {
        input: {
          pipelines: {
            [VECTOR_PIPELINE]: [buildVectorSearchStage(params)],
            [FULL_TEXT_PIPELINE]: [buildFullTextSearchStage(params), { $limit: params.limit }],
          },
        },
        combination: {
          weights: {
            [VECTOR_PIPELINE]: params.weights.vectorPipeline,
            [FULL_TEXT_PIPELINE]: params.weights.fullTextPipeline,
          },
        },
        scoreDetails: true,
      },
    },
    { $limit: params.fusedLimit },
    { $project: { ...CHUNK_PROJECTION, scoreDetails: { $meta: "scoreDetails" } } },
  ];
}

/** Stand-alone sub-pipelines for the client-side fusion fallback. */
export function buildClientFusionPipelines(params: PipelineParams): Record<FusionPipelineName, Document[]> {
  return {
    [VECTOR_PIPELINE]: [
      buildVectorSearchStage(params),
      { $project: { ...CHUNK_PROJECTION, score: { $meta: "vectorSearchScore" } } },
    ],
    [FULL_TEXT_PIPELINE]: [
      buildFullTextSearchStage(params),
      { $limit: params.limit },
      { $project: { ...CHUNK_PROJECTION, score: { $meta: "searchScore" } } },
    ],
  };
}

// ---------------------------------------------------------------------------
// Fusion results
// ---------------------------------------------------------------------------

interface ChunkFields {
  _id: string;
  documentId: string;
  fileName: string;
  chunkIndex: number;
  sectionTitle: string;
  sanitizedContent: string;
  placeholderTokens: string[];
}

export interface FusedCandidate {
  chunk: ChunkFields;
  fusionScore: number;
  pipelines: Record<FusionPipelineName, PipelineContribution | null>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toChunkFields(doc: Document): ChunkFields {
  const id = doc["_id"];
  const documentId = doc["documentId"];
  const content = doc["sanitizedContent"];
  if (typeof id !== "string" || typeof documentId !== "string" || typeof content !== "string") {
    throw new Error("Retrieval returned a malformed document_chunks record");
  }
  const tokens = doc["placeholderTokens"];
  return {
    _id: id,
    documentId,
    fileName: typeof doc["fileName"] === "string" ? doc["fileName"] : "",
    chunkIndex: typeof doc["chunkIndex"] === "number" ? doc["chunkIndex"] : 0,
    sectionTitle: typeof doc["sectionTitle"] === "string" ? doc["sectionTitle"] : "",
    sanitizedContent: content,
    placeholderTokens: Array.isArray(tokens)
      ? tokens.filter((t): t is string => typeof t === "string")
      : [],
  };
}

/**
 * Normalizes `$meta: "scoreDetails"` from `$rankFusion`:
 * `{ value, details: [{ inputPipelineName, rank, weight, value? }, ...] }`.
 * A pipeline that did not return the document is reported as `null`
 * (absent from `details`, or present with rank 0).
 */
export function parseRankFusionScoreDetails(raw: unknown): {
  score: number;
  pipelines: Record<FusionPipelineName, PipelineContribution | null>;
} {
  const pipelines: Record<FusionPipelineName, PipelineContribution | null> = {
    [VECTOR_PIPELINE]: null,
    [FULL_TEXT_PIPELINE]: null,
  };
  if (!isRecord(raw)) {
    return { score: 0, pipelines };
  }
  const details = Array.isArray(raw["details"]) ? raw["details"] : [];
  for (const entry of details) {
    if (!isRecord(entry)) {
      continue;
    }
    const name = entry["inputPipelineName"];
    const rank = finiteOrNull(entry["rank"]);
    if ((name !== VECTOR_PIPELINE && name !== FULL_TEXT_PIPELINE) || rank === null || rank < 1) {
      continue;
    }
    pipelines[name] = {
      rank,
      weight: finiteOrNull(entry["weight"]) ?? 1,
      score: finiteOrNull(entry["value"]),
    };
  }
  return { score: finiteOrNull(raw["value"]) ?? 0, pipelines };
}

/**
 * Weighted Reciprocal Rank Fusion, identical to `$rankFusion`:
 * score(d) = sum over pipelines of weight / (60 + rank(d)), rank 1-based.
 * Ties break on vector rank, then chunk id, so ordering is deterministic.
 */
export function reciprocalRankFusion(
  ranked: Record<FusionPipelineName, readonly Document[]>,
  weights: FusionWeights,
  limit: number,
): FusedCandidate[] {
  const byId = new Map<string, FusedCandidate>();
  for (const name of [VECTOR_PIPELINE, FULL_TEXT_PIPELINE] as const) {
    const weight = weights[name];
    ranked[name].forEach((doc, index) => {
      const chunk = toChunkFields(doc);
      const rank = index + 1;
      const existing =
        byId.get(chunk._id) ??
        ({ chunk, fusionScore: 0, pipelines: { [VECTOR_PIPELINE]: null, [FULL_TEXT_PIPELINE]: null } } satisfies FusedCandidate);
      if (existing.pipelines[name]) {
        return; // a pipeline never ranks the same chunk twice; keep the first
      }
      existing.pipelines[name] = { rank, weight, score: finiteOrNull(doc["score"]) };
      existing.fusionScore += weight / (RRF_K + rank);
      byId.set(chunk._id, existing);
    });
  }
  const vectorRank = (c: FusedCandidate): number =>
    c.pipelines[VECTOR_PIPELINE]?.rank ?? Number.POSITIVE_INFINITY;
  return [...byId.values()]
    .sort(
      (a, b) =>
        b.fusionScore - a.fusionScore ||
        vectorRank(a) - vectorRank(b) ||
        a.chunk._id.localeCompare(b.chunk._id),
    )
    .slice(0, limit);
}

function isUnsupportedRankFusionError(error: unknown): boolean {
  if (!isRecord(error) && !(error instanceof Error)) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  const message = (error as { message?: unknown }).message;
  return (
    code === UNRECOGNIZED_STAGE_CODE ||
    (typeof message === "string" && /\$rankFusion/.test(message) && /unrecognized|not (?:supported|allowed|enabled)/i.test(message))
  );
}

export function citationMarker(position: number): string {
  return `[CIT-${String(position).padStart(2, "0")}]`;
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/** Text shown to the reranker: the section path gives a short chunk its context. */
export function rerankDocumentText(chunk: Pick<ChunkFields, "sectionTitle" | "sanitizedContent">): string {
  return chunk.sectionTitle ? `${chunk.sectionTitle}\n\n${chunk.sanitizedContent}` : chunk.sanitizedContent;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export function createRetrievalService(config: RetrievalServiceConfig): RetrievalService {
  const weights: FusionWeights = {
    vectorPipeline: config.weights?.vectorPipeline ?? 1,
    fullTextPipeline: config.weights?.fullTextPipeline ?? 1,
  };
  const rerankCandidates = config.rerankCandidates ?? DEFAULT_RERANK_CANDIDATES;
  const topK = Math.min(config.topK ?? DEFAULT_TOP_K, rerankCandidates);
  const numCandidates = config.numCandidates ?? rerankCandidates * 10;
  let mode: FusionMode = config.fusionMode ?? "auto";

  async function fuseNative(params: PipelineParams): Promise<FusedCandidate[]> {
    const docs = await config.aggregator.aggregate(
      buildRankFusionPipeline({ ...params, weights, fusedLimit: rerankCandidates }),
    );
    return docs.map((doc) => {
      const { score, pipelines } = parseRankFusionScoreDetails(doc["scoreDetails"]);
      return { chunk: toChunkFields(doc), fusionScore: score, pipelines };
    });
  }

  async function fuseClient(params: PipelineParams): Promise<FusedCandidate[]> {
    const pipelines = buildClientFusionPipelines(params);
    const [vector, fullText] = await Promise.all([
      config.aggregator.aggregate(pipelines[VECTOR_PIPELINE]),
      config.aggregator.aggregate(pipelines[FULL_TEXT_PIPELINE]),
    ]);
    return reciprocalRankFusion(
      { [VECTOR_PIPELINE]: vector, [FULL_TEXT_PIPELINE]: fullText },
      weights,
      rerankCandidates,
    );
  }

  async function fuse(params: PipelineParams): Promise<{ candidates: FusedCandidate[]; source: FusionSource }> {
    if (mode === "client") {
      return { candidates: await fuseClient(params), source: "client" };
    }
    try {
      return { candidates: await fuseNative(params), source: "native" };
    } catch (error) {
      if (mode !== "auto" || !isUnsupportedRankFusionError(error)) {
        throw error;
      }
      // The server predates $rankFusion (< 8.1); remember that for later queries.
      mode = "client";
      return { candidates: await fuseClient(params), source: "client" };
    }
  }

  return {
    async retrieve(query, options = {}) {
      const started = performance.now();
      const trimmed = query.trim();
      if (trimmed.length === 0) {
        throw new Error("Retrieval query must not be empty");
      }
      if (trimmed.length > MAX_QUERY_CHARS) {
        throw new Error(`Retrieval query exceeds ${MAX_QUERY_CHARS} characters`);
      }
      // Fail closed before the query reaches Voyage or MongoDB.
      const leaks = detectRawPiiLeakage(trimmed);
      if (leaks.length > 0) {
        throw new RetrievalRejectedError([...new Set(leaks.map((leak) => leak.category))]);
      }

      const queryVector = await config.voyage.embedQuery(trimmed);
      const embedded = performance.now();

      const { candidates, source } = await fuse({
        query: trimmed,
        queryVector,
        limit: rerankCandidates,
        numCandidates: Math.max(numCandidates, rerankCandidates),
        ...(options.documentIds ? { documentIds: options.documentIds } : {}),
        ...(config.vectorIndex ? { vectorIndex: config.vectorIndex } : {}),
        ...(config.searchIndex ? { searchIndex: config.searchIndex } : {}),
      });
      const fused = performance.now();

      const reranked =
        candidates.length === 0
          ? []
          : await config.voyage.rerank(
              trimmed,
              candidates.map((candidate) => rerankDocumentText(candidate.chunk)),
              topK,
            );
      const finished = performance.now();

      const chunks: RetrievedChunk[] = [];
      for (const result of reranked.slice(0, topK)) {
        const candidate = candidates[result.index];
        if (!candidate) {
          throw new Error(`Reranker returned out-of-range index ${result.index}`);
        }
        const position = chunks.length + 1;
        const { chunk } = candidate;
        chunks.push({
          chunkId: chunk._id,
          documentId: chunk.documentId,
          fileName: chunk.fileName,
          chunkIndex: chunk.chunkIndex,
          sectionTitle: chunk.sectionTitle || chunk.fileName || "Untitled section",
          sanitizedContent: chunk.sanitizedContent,
          placeholderTokens: chunk.placeholderTokens,
          citationMarker: citationMarker(position),
          score: clamp01(result.relevanceScore),
          scoreDetails: {
            fusion: {
              method: "reciprocalRankFusion",
              source,
              score: candidate.fusionScore,
              rank: result.index + 1,
              pipelines: candidate.pipelines,
            },
            rerank: {
              model: config.voyage.mode === "mock" ? `${VOYAGE_RERANK_MODEL}-mock` : VOYAGE_RERANK_MODEL,
              relevanceScore: result.relevanceScore,
              rank: position,
            },
          },
        });
      }

      return {
        chunks,
        fusionSource: source,
        candidateCount: candidates.length,
        timings: {
          embedMs: embedded - started,
          fusionMs: fused - embedded,
          rerankMs: finished - fused,
          totalMs: finished - started,
        },
      };
    },
  };
}
