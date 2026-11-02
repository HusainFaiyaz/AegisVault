import type { Document, SearchIndexDescription } from "mongodb";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { CitationChunkSchema } from "@aegis/shared";
import {
  DOCUMENT_CHUNKS_SEARCH_INDEX,
  DOCUMENT_CHUNKS_VECTOR_INDEX,
  type DocumentChunkDoc,
} from "../models/document-chunk.model.js";
import {
  buildSearchIndexDescriptions,
  definitionContains,
  ensureSearchIndexes,
  type SearchIndexAdmin,
  type SearchIndexInfo,
} from "../scripts/setup-indexes.js";
import {
  buildClientFusionPipelines,
  buildFullTextSearchStage,
  buildRankFusionPipeline,
  buildVectorSearchStage,
  createRetrievalService,
  extractQueryTokens,
  FULL_TEXT_PIPELINE,
  parseRankFusionScoreDetails,
  reciprocalRankFusion,
  RetrievalRejectedError,
  RRF_K,
  VECTOR_PIPELINE,
  type ChunkAggregator,
  type PipelineParams,
} from "../services/retrieval.service.js";
import {
  createMockVoyageService,
  EMBEDDING_DIMENSIONS,
  type VoyageService,
} from "../services/voyage.service.js";

// ---------------------------------------------------------------------------
// In-memory Atlas: interprets exactly the stages retrieval.service.ts emits
// ($rankFusion, $vectorSearch, $search compound/text/in, $limit, $project)
// so the service is exercised end to end without a live cluster.
// ---------------------------------------------------------------------------

interface Row {
  doc: DocumentChunkDoc;
  score?: number;
  scoreDetails?: Document;
}

function analyze(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9_.]+/)
      .map((term) => term.replace(/^\.+|\.+$/g, ""))
      .filter((term) => term.length > 0),
  );
}

function fieldValue(doc: DocumentChunkDoc, path: string): unknown {
  return (doc as unknown as Record<string, unknown>)[path];
}

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return dot;
}

function rankFusionUnsupported(): Error {
  return Object.assign(new Error("Unrecognized pipeline stage name: '$rankFusion'"), { code: 40324 });
}

class FakeAtlas implements ChunkAggregator {
  readonly calls: Document[][] = [];

  constructor(
    readonly docs: DocumentChunkDoc[],
    public supportsRankFusion = true,
  ) {}

  async aggregate(pipeline: Document[]): Promise<Document[]> {
    this.calls.push(pipeline);
    const rows = this.run(pipeline);
    return rows.map((row) => row as unknown as Document);
  }

  private run(pipeline: Document[]): Row[] | Document[] {
    let rows: Row[] = [];
    for (const [i, stage] of pipeline.entries()) {
      if (stage["$rankFusion"]) {
        if (!this.supportsRankFusion) {
          throw rankFusionUnsupported();
        }
        rows = this.rankFusion(stage["$rankFusion"] as Document);
      } else if (stage["$vectorSearch"]) {
        rows = this.vectorSearch(stage["$vectorSearch"] as Document);
      } else if (stage["$search"]) {
        rows = this.search(stage["$search"] as Document);
      } else if (stage["$limit"] !== undefined) {
        rows = rows.slice(0, stage["$limit"] as number);
      } else if (stage["$project"]) {
        if (i !== pipeline.length - 1) {
          throw new Error("fake only supports a trailing $project");
        }
        return rows.map((row) => project(row, stage["$project"] as Document));
      } else {
        throw new Error(`fake does not support stage ${Object.keys(stage).join(",")}`);
      }
    }
    return rows.map((row) => row.doc as unknown as Document);
  }

  private subRows(pipeline: Document[]): Row[] {
    let rows: Row[] = [];
    for (const stage of pipeline) {
      if (stage["$vectorSearch"]) rows = this.vectorSearch(stage["$vectorSearch"] as Document);
      else if (stage["$search"]) rows = this.search(stage["$search"] as Document);
      else if (stage["$limit"] !== undefined) rows = rows.slice(0, stage["$limit"] as number);
      else throw new Error("unsupported sub-pipeline stage");
    }
    return rows;
  }

  private filterIds(filter: Document | undefined): Set<string> | null {
    const ids = (filter?.["documentId"] as Document | undefined)?.["$in"];
    return Array.isArray(ids) ? new Set(ids as string[]) : null;
  }

  private vectorSearch(spec: Document): Row[] {
    expect(spec["index"]).toBe(DOCUMENT_CHUNKS_VECTOR_INDEX);
    const query = spec["queryVector"] as number[];
    const allowed = this.filterIds(spec["filter"] as Document | undefined);
    return this.docs
      .filter((doc) => !allowed || allowed.has(doc.documentId))
      .map((doc) => ({ doc, score: (1 + cosine(query, doc.embedding)) / 2 }))
      .sort((a, b) => b.score - a.score)
      .slice(0, spec["limit"] as number);
  }

  private clauseScore(clause: Document, doc: DocumentChunkDoc): number | null {
    const boost = ((clause["score"] as Document | undefined)?.["boost"] as Document | undefined)?.["value"];
    const weight = typeof boost === "number" ? boost : 1;
    if (clause["text"]) {
      const spec = clause["text"] as Document;
      const field = fieldValue(doc, spec["path"] as string);
      const haystack = analyze(typeof field === "string" ? field : "");
      const hits = [...analyze(spec["query"] as string)].filter((term) => haystack.has(term)).length;
      return hits > 0 ? hits * weight : null;
    }
    if (clause["in"]) {
      const spec = clause["in"] as Document;
      const field = fieldValue(doc, spec["path"] as string);
      const values = Array.isArray(field) ? field : [field];
      const wanted = spec["value"] as unknown[];
      return values.some((value) => wanted.includes(value)) ? weight : null;
    }
    throw new Error("unsupported search operator");
  }

  private search(spec: Document): Row[] {
    expect(spec["index"]).toBe(DOCUMENT_CHUNKS_SEARCH_INDEX);
    const compound = spec["compound"] as Document;
    const should = compound["should"] as Document[];
    const filters = (compound["filter"] as Document[] | undefined) ?? [];
    const minimum = (compound["minimumShouldMatch"] as number | undefined) ?? 0;
    const rows: Row[] = [];
    for (const doc of this.docs) {
      if (filters.some((clause) => this.clauseScore(clause, doc) === null)) continue;
      const scores = should.map((clause) => this.clauseScore(clause, doc)).filter((s): s is number => s !== null);
      if (scores.length < minimum) continue;
      rows.push({ doc, score: scores.reduce((sum, s) => sum + s, 0) });
    }
    return rows.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.doc._id.localeCompare(b.doc._id));
  }

  private rankFusion(spec: Document): Row[] {
    const pipelines = (spec["input"] as Document)["pipelines"] as Record<string, Document[]>;
    const weights = (spec["combination"] as Document)["weights"] as Record<string, number>;
    const names = Object.keys(pipelines);
    const ranked = new Map(names.map((name) => [name, this.subRows(pipelines[name] ?? [])]));
    const all = new Map<string, DocumentChunkDoc>();
    for (const rows of ranked.values()) for (const row of rows) all.set(row.doc._id, row.doc);

    const fused: Row[] = [...all.values()].map((doc) => {
      let value = 0;
      const details = names.map((name) => {
        const rows = ranked.get(name) ?? [];
        const index = rows.findIndex((row) => row.doc._id === doc._id);
        const weight = weights[name] ?? 1;
        if (index < 0) {
          return { inputPipelineName: name, rank: 0, weight, details: [] };
        }
        value += weight / (RRF_K + index + 1);
        return { inputPipelineName: name, rank: index + 1, weight, value: rows[index]?.score, details: [] };
      });
      return { doc, scoreDetails: { value, description: "reciprocal rank fusion", details } };
    });
    return fused.sort(
      (a, b) => ((b.scoreDetails?.["value"] as number) - (a.scoreDetails?.["value"] as number)) || a.doc._id.localeCompare(b.doc._id),
    );
  }
}

function project(row: Row, spec: Document): Document {
  const out: Document = {};
  for (const [key, value] of Object.entries(spec)) {
    if (value === 1) {
      out[key] = fieldValue(row.doc, key);
    } else if (typeof value === "object" && value !== null && "$meta" in value) {
      const meta = (value as Document)["$meta"];
      out[key] = meta === "scoreDetails" ? row.scoreDetails : row.score;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

const DOC_A = "a1111111-1111-4111-8111-111111111111";
const DOC_B = "b2222222-2222-4222-8222-222222222222";
const DOC_C = "c3333333-3333-4333-8333-333333333333";

const FILLER_TOPICS = [
  "Blood pressure was 128/82 and stable on lisinopril 10 mg daily.",
  "Chest radiograph shows resolving right lower lobe consolidation.",
  "Physiotherapy recommends daily walking and incentive spirometry.",
  "HbA1c of 6.9% reviewed; continue metformin 500 mg twice daily.",
  "Renal function within normal limits; eGFR 78 mL/min.",
  "Smoking cessation counselling delivered; nicotine patch offered.",
  "Vaccination record updated with seasonal influenza vaccine.",
  "Dietitian advised low-sodium diet and increased fluid intake.",
  "Sleep study scheduled to evaluate suspected obstructive apnoea.",
  "Wound inspected; sutures intact with no sign of infection.",
];

function chunkId(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

let corpus: DocumentChunkDoc[] = [];
const mockVoyage = createMockVoyageService();

async function buildCorpus(): Promise<DocumentChunkDoc[]> {
  const specs: Array<{ documentId: string; fileName: string; sectionTitle: string; content: string }> = [
    {
      documentId: DOC_A,
      fileName: "discharge-summary.md",
      sectionTitle: "Discharge Summary > Allergies",
      content: "Patient [PER_89A1] (MRN [MRN_3F90]) reports a penicillin allergy causing hives.",
    },
    {
      documentId: DOC_A,
      fileName: "discharge-summary.md",
      sectionTitle: "Discharge Summary > Diagnosis",
      content: "Community-acquired pneumonia, ICD-10 J18.9, treated at [ORG_12C4].",
    },
    {
      documentId: DOC_A,
      fileName: "discharge-summary.md",
      sectionTitle: "Discharge Summary > Cardiology",
      content: "Myocardial infarction in 2019; cardiology review booked with [PER_4B21].",
    },
    {
      documentId: DOC_B,
      fileName: "referral-letter.md",
      sectionTitle: "Referral > Allergies",
      content: "Patient [PER_77C0] (MRN [MRN_3F91]) reports a penicillin allergy causing hives.",
    },
  ];
  for (let i = 0; i < 30; i += 1) {
    specs.push({
      documentId: DOC_C,
      fileName: "clinic-notes.md",
      sectionTitle: `Clinic Notes > Visit ${i + 1}`,
      content: `${FILLER_TOPICS[i % FILLER_TOPICS.length]} Allergy status unchanged at visit ${i + 1}.`,
    });
  }
  const docs: DocumentChunkDoc[] = [];
  for (const [i, spec] of specs.entries()) {
    const [embedding] = await mockVoyage.embedDocumentChunks([spec.content]);
    docs.push({
      _id: chunkId(i + 1),
      documentId: spec.documentId,
      fileName: spec.fileName,
      chunkIndex: i,
      sectionTitle: spec.sectionTitle,
      sanitizedContent: spec.content,
      placeholderTokens: [...new Set(spec.content.match(/\[[A-Z_]+_[0-9A-F]{4}\]/g) ?? [])],
      embedding: embedding ?? [],
      embeddingModel: mockVoyage.embeddingModel,
      createdAt: new Date("2026-11-02T09:00:00.000Z"),
    });
  }
  return docs;
}

beforeAll(async () => {
  corpus = await buildCorpus();
});

function byContent(fragment: string): DocumentChunkDoc {
  const doc = corpus.find((chunk) => chunk.sanitizedContent.includes(fragment));
  if (!doc) throw new Error(`no chunk containing ${fragment}`);
  return doc;
}

const params: PipelineParams = {
  query: "penicillin allergy for [MRN_3F90]",
  queryVector: [0.1, 0.2, 0.3],
  limit: 25,
  numCandidates: 250,
};

// ---------------------------------------------------------------------------
// Pipeline builders
// ---------------------------------------------------------------------------

describe("pipeline builders", () => {
  it("extracts placeholder tokens from the query in their stored upper-case form", () => {
    expect(extractQueryTokens("compare [mrn_3f90] with [MRN_3F90] and [PER_89A1]")).toEqual([
      "[MRN_3F90]",
      "[PER_89A1]",
    ]);
    expect(extractQueryTokens("no identifiers here")).toEqual([]);
  });

  it("builds a $vectorSearch stage over the embedding index with an optional documentId pre-filter", () => {
    expect(buildVectorSearchStage(params)).toEqual({
      $vectorSearch: {
        index: DOCUMENT_CHUNKS_VECTOR_INDEX,
        path: "embedding",
        queryVector: [0.1, 0.2, 0.3],
        numCandidates: 250,
        limit: 25,
      },
    });
    const scoped = buildVectorSearchStage({ ...params, documentIds: [DOC_A] });
    expect(scoped["$vectorSearch"].filter).toEqual({ documentId: { $in: [DOC_A] } });
  });

  it("builds a BM25 $search over sanitizedContent and sectionTitle with an exact placeholder clause", () => {
    const stage = buildFullTextSearchStage(params)["$search"];
    expect(stage.index).toBe(DOCUMENT_CHUNKS_SEARCH_INDEX);
    expect(stage.compound.minimumShouldMatch).toBe(1);
    const paths = stage.compound.should.map((clause: Document) => clause["text"]?.path ?? clause["in"]?.path);
    expect(paths).toEqual(["sanitizedContent", "sectionTitle", "placeholderTokens"]);
    expect(stage.compound.should[2].in.value).toEqual(["[MRN_3F90]"]);
    expect(stage.compound.filter).toBeUndefined();

    const plain = buildFullTextSearchStage({ ...params, query: "penicillin allergy", documentIds: [DOC_B] });
    expect(plain["$search"].compound.should).toHaveLength(2);
    expect(plain["$search"].compound.filter).toEqual([{ in: { path: "documentId", value: [DOC_B] } }]);
  });

  it("builds a native $rankFusion pipeline with named weighted sub-pipelines and scoreDetails", () => {
    const pipeline = buildRankFusionPipeline({
      ...params,
      weights: { vectorPipeline: 1, fullTextPipeline: 1.5 },
      fusedLimit: 25,
    });
    const fusion = pipeline[0]?.["$rankFusion"];
    expect(Object.keys(fusion.input.pipelines)).toEqual([VECTOR_PIPELINE, FULL_TEXT_PIPELINE]);
    expect(fusion.input.pipelines[VECTOR_PIPELINE][0]).toHaveProperty("$vectorSearch");
    expect(fusion.input.pipelines[FULL_TEXT_PIPELINE][0]).toHaveProperty("$search");
    expect(fusion.input.pipelines[FULL_TEXT_PIPELINE][1]).toEqual({ $limit: 25 });
    expect(fusion.combination.weights).toEqual({ vectorPipeline: 1, fullTextPipeline: 1.5 });
    expect(fusion.scoreDetails).toBe(true);
    expect(pipeline[1]).toEqual({ $limit: 25 });
    const projection = pipeline[2]?.["$project"];
    expect(projection.scoreDetails).toEqual({ $meta: "scoreDetails" });
    expect(projection).not.toHaveProperty("embedding");
  });

  it("builds stand-alone sub-pipelines with raw scores for the client-side fallback", () => {
    const pipelines = buildClientFusionPipelines(params);
    expect(pipelines[VECTOR_PIPELINE].at(-1)?.["$project"].score).toEqual({ $meta: "vectorSearchScore" });
    expect(pipelines[FULL_TEXT_PIPELINE].at(-1)?.["$project"].score).toEqual({ $meta: "searchScore" });
  });
});

// ---------------------------------------------------------------------------
// Fusion maths
// ---------------------------------------------------------------------------

describe("reciprocal rank fusion", () => {
  const doc = (id: string): Document => ({ _id: id, documentId: DOC_A, sanitizedContent: id });

  it("matches $rankFusion's weight / (60 + rank) formula and favours chunks found by both pipelines", () => {
    const fused = reciprocalRankFusion(
      { vectorPipeline: [doc("a"), doc("b")], fullTextPipeline: [doc("c"), doc("b")] },
      { vectorPipeline: 1, fullTextPipeline: 1 },
      10,
    );
    expect(fused.map((c) => c.chunk._id)).toEqual(["b", "a", "c"]);
    expect(fused[0]?.fusionScore).toBeCloseTo(1 / (RRF_K + 2) + 1 / (RRF_K + 2), 12);
    expect(fused[1]?.fusionScore).toBeCloseTo(1 / (RRF_K + 1), 12);
    expect(fused[1]?.pipelines.fullTextPipeline).toBeNull();
  });

  it("respects pipeline weights and the result limit", () => {
    const fused = reciprocalRankFusion(
      { vectorPipeline: [doc("a")], fullTextPipeline: [doc("c")] },
      { vectorPipeline: 1, fullTextPipeline: 3 },
      1,
    );
    expect(fused.map((c) => c.chunk._id)).toEqual(["c"]);
    expect(fused[0]?.fusionScore).toBeCloseTo(3 / (RRF_K + 1), 12);
  });

  it("parses native scoreDetails, treating rank 0 or a missing entry as 'not returned'", () => {
    const parsed = parseRankFusionScoreDetails({
      value: 0.0325,
      details: [
        { inputPipelineName: "vectorPipeline", rank: 3, weight: 1, value: 0.91, details: [] },
        { inputPipelineName: "fullTextPipeline", rank: 0, weight: 2, details: [] },
      ],
    });
    expect(parsed.score).toBe(0.0325);
    expect(parsed.pipelines.vectorPipeline).toEqual({ rank: 3, weight: 1, score: 0.91 });
    expect(parsed.pipelines.fullTextPipeline).toBeNull();
    expect(parseRankFusionScoreDetails(undefined).pipelines).toEqual({ vectorPipeline: null, fullTextPipeline: null });
  });
});

// ---------------------------------------------------------------------------
// Service end to end (fake Atlas + deterministic mock Voyage)
// ---------------------------------------------------------------------------

function spiedVoyage(base: VoyageService = mockVoyage): VoyageService & {
  embedQuery: ReturnType<typeof vi.fn>;
  rerank: ReturnType<typeof vi.fn>;
} {
  return {
    ...base,
    mode: base.mode,
    embeddingModel: base.embeddingModel,
    embedDocumentChunks: (chunks) => base.embedDocumentChunks(chunks),
    embedQuery: vi.fn((query: string) => base.embedQuery(query)),
    rerank: vi.fn((query: string, documents: readonly string[], topK?: number) => base.rerank(query, documents, topK)),
  };
}

describe("createRetrievalService", () => {
  it("runs native $rankFusion, reranks the top 25 fused candidates and returns the top 5 with scoreDetails", async () => {
    const atlas = new FakeAtlas(corpus);
    const voyage = spiedVoyage();
    const service = createRetrievalService({ aggregator: atlas, voyage });

    const result = await service.retrieve("penicillin allergy hives");

    expect(atlas.calls).toHaveLength(1);
    expect(atlas.calls[0]?.[0]).toHaveProperty("$rankFusion");
    expect(result.fusionSource).toBe("native");
    expect(result.candidateCount).toBe(25);

    expect(voyage.rerank).toHaveBeenCalledTimes(1);
    const [rerankQuery, rerankDocs, rerankTopK] = voyage.rerank.mock.calls[0] ?? [];
    expect(rerankQuery).toBe("penicillin allergy hives");
    expect(rerankDocs).toHaveLength(25);
    expect(rerankTopK).toBe(5);

    expect(result.chunks).toHaveLength(5);
    expect(result.chunks.map((c) => c.citationMarker)).toEqual([
      "[CIT-01]",
      "[CIT-02]",
      "[CIT-03]",
      "[CIT-04]",
      "[CIT-05]",
    ]);
    for (const [i, chunk] of result.chunks.entries()) {
      expect(CitationChunkSchema.safeParse(chunk).success).toBe(true);
      expect(chunk).not.toHaveProperty("embedding");
      expect(chunk.scoreDetails.rerank).toMatchObject({ model: "rerank-2.5-mock", rank: i + 1 });
      expect(chunk.scoreDetails.fusion.source).toBe("native");
      expect(chunk.scoreDetails.fusion.score).toBeGreaterThan(0);
    }
    const scores = result.chunks.map((c) => c.scoreDetails.rerank.relevanceScore);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(result.timings.totalMs).toBeGreaterThanOrEqual(0);
  });

  it("ranks the exact anonymized identifier first via BM25, never its near-identical neighbour", async () => {
    const service = createRetrievalService({ aggregator: new FakeAtlas(corpus), voyage: mockVoyage });
    const target = byContent("[MRN_3F90]");
    const neighbour = byContent("[MRN_3F91]");

    const result = await service.retrieve("[MRN_3F90]");

    const top = result.chunks[0];
    expect(top?.chunkId).toBe(target._id);
    expect(top?.scoreDetails.fusion.pipelines.fullTextPipeline?.rank).toBe(1);
    const neighbourHit = result.chunks.find((c) => c.chunkId === neighbour._id);
    expect(neighbourHit?.scoreDetails.fusion.pipelines.fullTextPipeline ?? null).toBeNull();
  });

  it("matches ISO/ICD codes lexically", async () => {
    const service = createRetrievalService({ aggregator: new FakeAtlas(corpus), voyage: mockVoyage });
    const result = await service.retrieve("J18.9");
    expect(result.chunks[0]?.sanitizedContent).toContain("ICD-10 J18.9");
    expect(result.chunks[0]?.scoreDetails.fusion.pipelines.fullTextPipeline?.rank).toBe(1);
  });

  it("keeps semantic-only matches that share no words with the query (vectorPipeline only)", async () => {
    const cardiology = byContent("Myocardial infarction");
    const semantic = spiedVoyage({
      ...mockVoyage,
      // Stand-in for a real embedding model mapping "heart attack" close to "myocardial infarction".
      embedQuery: async () => cardiology.embedding,
    });
    const service = createRetrievalService({ aggregator: new FakeAtlas(corpus), voyage: semantic });

    await service.retrieve("heart attack history");

    const candidates = semantic.rerank.mock.calls[0]?.[1] as string[];
    expect(candidates[0]).toContain("Myocardial infarction");
    expect(analyzeOverlap("heart attack history", cardiology.sanitizedContent)).toBe(0);
  });

  it("returns chunks in reranked order, not fused order", async () => {
    const reversing = spiedVoyage({
      ...mockVoyage,
      rerank: async (_query, documents, topK) =>
        documents
          .map((_, index) => ({ index, relevanceScore: (index + 1) / documents.length }))
          .reverse()
          .slice(0, topK),
    });
    const service = createRetrievalService({ aggregator: new FakeAtlas(corpus), voyage: reversing });

    const result = await service.retrieve("allergy status");

    const sentToReranker = reversing.rerank.mock.calls[0]?.[1] as string[];
    expect(result.chunks.map((c) => `${c.sectionTitle}\n\n${c.sanitizedContent}`)).toEqual(
      sentToReranker.slice(20).reverse(),
    );
    expect(result.chunks.map((c) => c.scoreDetails.fusion.rank)).toEqual([25, 24, 23, 22, 21]);
    expect(result.chunks[0]?.score).toBe(1);
    expect(result.chunks[0]?.citationMarker).toBe("[CIT-01]");
  });

  it("scopes both pipelines to the requested documentIds", async () => {
    const atlas = new FakeAtlas(corpus);
    const service = createRetrievalService({ aggregator: atlas, voyage: mockVoyage });

    const result = await service.retrieve("penicillin allergy", { documentIds: [DOC_B] });

    expect(result.chunks.length).toBeGreaterThan(0);
    expect(result.chunks.every((c) => c.documentId === DOC_B)).toBe(true);
    const fusion = atlas.calls[0]?.[0]?.["$rankFusion"];
    expect(fusion.input.pipelines.vectorPipeline[0].$vectorSearch.filter).toEqual({ documentId: { $in: [DOC_B] } });
  });

  it("falls back to client-side RRF when the server predates $rankFusion, and remembers it", async () => {
    const atlas = new FakeAtlas(corpus, false);
    const service = createRetrievalService({ aggregator: atlas, voyage: mockVoyage });

    const first = await service.retrieve("[MRN_3F90] penicillin");
    expect(first.fusionSource).toBe("client");
    expect(first.chunks[0]?.chunkId).toBe(byContent("[MRN_3F90]")._id);
    expect(atlas.calls).toHaveLength(3); // rejected $rankFusion + 2 sub-pipelines

    const native = await createRetrievalService({ aggregator: new FakeAtlas(corpus), voyage: mockVoyage }).retrieve(
      "[MRN_3F90] penicillin",
    );
    expect(first.chunks.map((c) => c.chunkId)).toEqual(native.chunks.map((c) => c.chunkId));
    expect(first.chunks[0]?.scoreDetails.fusion.score).toBeCloseTo(native.chunks[0]?.scoreDetails.fusion.score ?? -1, 12);

    await service.retrieve("allergy");
    expect(atlas.calls).toHaveLength(5); // no second $rankFusion attempt
    expect(atlas.calls.slice(3).every((p) => !("$rankFusion" in (p[0] ?? {})))).toBe(true);
  });

  it("does not fall back in 'native' mode or on unrelated errors", async () => {
    const legacy = createRetrievalService({ aggregator: new FakeAtlas(corpus, false), voyage: mockVoyage, fusionMode: "native" });
    await expect(legacy.retrieve("allergy")).rejects.toMatchObject({ code: 40324 });

    const broken: ChunkAggregator = {
      aggregate: async () => {
        throw Object.assign(new Error("index not found"), { code: 8 });
      },
    };
    await expect(createRetrievalService({ aggregator: broken, voyage: mockVoyage }).retrieve("allergy")).rejects.toThrow(
      "index not found",
    );
  });

  it("rejects a query carrying raw PII before it reaches Voyage or MongoDB", async () => {
    const atlas = new FakeAtlas(corpus);
    const voyage = spiedVoyage();
    const service = createRetrievalService({ aggregator: atlas, voyage });

    const attempt = service.retrieve("allergies for SSN 123-45-6789");
    await expect(attempt).rejects.toBeInstanceOf(RetrievalRejectedError);
    await expect(attempt).rejects.toMatchObject({ code: "ZERO_TRUST_VIOLATION" });
    await expect(attempt).rejects.not.toThrow("123-45-6789");
    expect(voyage.embedQuery).not.toHaveBeenCalled();
    expect(atlas.calls).toHaveLength(0);
  });

  it("returns no chunks without calling the reranker when nothing matches", async () => {
    const voyage = spiedVoyage();
    const service = createRetrievalService({ aggregator: new FakeAtlas([]), voyage });

    const result = await service.retrieve("penicillin allergy");

    expect(result.chunks).toEqual([]);
    expect(result.candidateCount).toBe(0);
    expect(voyage.rerank).not.toHaveBeenCalled();
  });

  it("rejects empty and oversized queries", async () => {
    const service = createRetrievalService({ aggregator: new FakeAtlas(corpus), voyage: mockVoyage });
    await expect(service.retrieve("   ")).rejects.toThrow("must not be empty");
    await expect(service.retrieve("a".repeat(4_001))).rejects.toThrow("exceeds");
  });
});

function analyzeOverlap(a: string, b: string): number {
  const right = analyze(b);
  return [...analyze(a)].filter((term) => right.has(term)).length;
}

// ---------------------------------------------------------------------------
// setup-indexes
// ---------------------------------------------------------------------------

class FakeSearchIndexAdmin implements SearchIndexAdmin {
  readonly indexes = new Map<string, SearchIndexInfo>();
  readonly created: string[][] = [];
  readonly updated: string[] = [];
  /** Number of list() calls an index stays non-queryable after create/update. */
  buildPolls = 1;
  private readonly pending = new Map<string, number>();

  async list(): Promise<SearchIndexInfo[]> {
    for (const [name, remaining] of this.pending) {
      const info = this.indexes.get(name);
      if (!info) continue;
      if (remaining <= 0) {
        info.queryable = true;
        info.status = "READY";
        this.pending.delete(name);
      } else {
        this.pending.set(name, remaining - 1);
      }
    }
    return [...this.indexes.values()].map((info) => ({ ...info }));
  }

  async create(descriptions: SearchIndexDescription[]): Promise<string[]> {
    const names = descriptions.map((d) => d.name ?? "default");
    this.created.push(names);
    for (const d of descriptions) {
      this.indexes.set(d.name ?? "default", {
        name: d.name ?? "default",
        ...(d.type ? { type: d.type } : {}),
        status: "BUILDING",
        queryable: false,
        latestDefinition: withAtlasDefaults(d.definition),
      });
      this.pending.set(d.name ?? "default", this.buildPolls);
    }
    return names;
  }

  async update(name: string, definition: Document): Promise<void> {
    this.updated.push(name);
    const info = this.indexes.get(name);
    if (info) {
      info.latestDefinition = withAtlasDefaults(definition);
      this.pending.set(name, this.buildPolls);
    }
  }
}

/** Atlas stores definitions with extra defaulted keys; drift detection must ignore those. */
function withAtlasDefaults(definition: Document): Document {
  return { storedSource: false, numPartitions: 1, ...structuredClone(definition) };
}

describe("setup-indexes", () => {
  it("defines a 1024-d cosine vector index with a documentId filter and a BM25 text index", () => {
    const [vector, text] = buildSearchIndexDescriptions();
    expect(vector).toMatchObject({ name: DOCUMENT_CHUNKS_VECTOR_INDEX, type: "vectorSearch" });
    expect(vector?.definition["fields"]).toEqual([
      { type: "vector", path: "embedding", numDimensions: EMBEDDING_DIMENSIONS, similarity: "cosine" },
      { type: "filter", path: "documentId" },
    ]);
    expect(text).toMatchObject({ name: DOCUMENT_CHUNKS_SEARCH_INDEX, type: "search" });
    const fields = text?.definition["mappings"].fields;
    expect(text?.definition["mappings"].dynamic).toBe(false);
    expect(fields.sanitizedContent).toEqual({ type: "string", analyzer: "lucene.standard" });
    expect(fields.sectionTitle).toEqual({ type: "string", analyzer: "lucene.standard" });
    expect(fields.placeholderTokens).toEqual({ type: "token" });
    expect(fields.documentId).toEqual({ type: "token" });
  });

  it("creates missing indexes in one call and waits until they are queryable", async () => {
    const admin = new FakeSearchIndexAdmin();
    admin.buildPolls = 2;
    const sleep = vi.fn(async () => undefined);

    const result = await ensureSearchIndexes(admin, buildSearchIndexDescriptions(), { sleep, pollIntervalMs: 10 });

    expect(result.created).toEqual([DOCUMENT_CHUNKS_VECTOR_INDEX, DOCUMENT_CHUNKS_SEARCH_INDEX]);
    expect(admin.created).toHaveLength(1);
    expect(sleep).toHaveBeenCalled();
    expect([...admin.indexes.values()].every((info) => info.queryable)).toBe(true);
  });

  it("is idempotent: matching definitions (plus Atlas defaults) are left alone", async () => {
    const admin = new FakeSearchIndexAdmin();
    await ensureSearchIndexes(admin, buildSearchIndexDescriptions(), { sleep: async () => undefined });

    const second = await ensureSearchIndexes(admin, buildSearchIndexDescriptions(), { sleep: async () => undefined });

    expect(second).toEqual({
      created: [],
      updated: [],
      unchanged: [DOCUMENT_CHUNKS_VECTOR_INDEX, DOCUMENT_CHUNKS_SEARCH_INDEX],
    });
    expect(admin.created).toHaveLength(1);
    expect(admin.updated).toEqual([]);
  });

  it("updates an index whose definition drifted (e.g. embedding dimensions changed)", async () => {
    const admin = new FakeSearchIndexAdmin();
    await ensureSearchIndexes(admin, buildSearchIndexDescriptions(512), { sleep: async () => undefined });

    const result = await ensureSearchIndexes(admin, buildSearchIndexDescriptions(), { sleep: async () => undefined });

    expect(result.updated).toEqual([DOCUMENT_CHUNKS_VECTOR_INDEX]);
    expect(result.unchanged).toEqual([DOCUMENT_CHUNKS_SEARCH_INDEX]);
  });

  it("fails on a type clash, a FAILED build, or a timeout", async () => {
    const clash = new FakeSearchIndexAdmin();
    clash.indexes.set(DOCUMENT_CHUNKS_VECTOR_INDEX, { name: DOCUMENT_CHUNKS_VECTOR_INDEX, type: "search", queryable: true });
    await expect(ensureSearchIndexes(clash, buildSearchIndexDescriptions(), { waitUntilQueryable: false })).rejects.toThrow(
      "drop it first",
    );

    const failed = new FakeSearchIndexAdmin();
    failed.buildPolls = 100;
    const failing = ensureSearchIndexes(failed, buildSearchIndexDescriptions(), {
      sleep: async () => {
        const info = failed.indexes.get(DOCUMENT_CHUNKS_SEARCH_INDEX);
        if (info) info.status = "FAILED";
      },
    });
    await expect(failing).rejects.toThrow("build failed");

    const slow = new FakeSearchIndexAdmin();
    slow.buildPolls = 100;
    await expect(
      ensureSearchIndexes(slow, buildSearchIndexDescriptions(), { sleep: async () => undefined, pollIntervalMs: 10, timeoutMs: 30 }),
    ).rejects.toThrow("Timed out");
  });

  it("compares definitions as a subset so server-side defaults are not treated as drift", () => {
    expect(definitionContains({ a: 1, b: { c: [1, { d: 2, extra: true }] }, extra: 1 }, { a: 1, b: { c: [1, { d: 2 }] } })).toBe(true);
    expect(definitionContains({ a: 1, b: { c: [1] } }, { a: 1, b: { c: [1, 2] } })).toBe(false);
    expect(definitionContains(undefined, { a: 1 })).toBe(false);
  });
});
