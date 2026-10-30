import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Writable } from "node:stream";
import { UnrecoverableError } from "bullmq";
import type { Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SanitizedDocumentUpload } from "@aegis/shared";
import { createApp, createLogger } from "../app.js";
import type { DocumentChunkDoc, DocumentChunkStore } from "../models/document-chunk.model.js";
import { createDocumentsRouter } from "../routes/documents.routes.js";
import { chunkSanitizedDocument } from "../services/chunker.service.js";
import {
  createMockVoyageService,
  createVoyageService,
  EMBEDDING_DIMENSIONS,
  groupByCharBudget,
  VoyageApiError,
  type VoyageService,
} from "../services/voyage.service.js";
import {
  chunkIdFor,
  processIngestionJob,
  type IngestionDeps,
  type IngestionJobData,
  type IngestionJobResult,
  type IngestionJobStatus,
  type IngestionQueue,
} from "../workers/ingestion.worker.js";

// ---------------------------------------------------------------------------
// Fixtures and fakes
// ---------------------------------------------------------------------------

const DISCHARGE_SUMMARY = `# Discharge Summary

Patient [PER_89A1] (MRN [MRN_3F90]) was admitted to [ORG_12C4] on 2026-03-02 with community-acquired pneumonia.

## Medications

Amoxicillin 500 mg three times daily for 7 days. Contact [PER_4B21] at [PHONE_7E0D] with questions.

## Follow-up

Review with [PER_4B21] in 2 weeks at the [LOC_0A9F] clinic. Billing reference [IBAN_5C3E].`;

function upload(overrides: Partial<SanitizedDocumentUpload> = {}): SanitizedDocumentUpload {
  return {
    documentId: randomUUID(),
    fileName: "discharge-summary.md",
    mimeType: "text/markdown",
    sanitizedContent: DISCHARGE_SUMMARY,
    entities: [
      { token: "[PER_89A1]", category: "PER", confidence: 0.98 },
      { token: "[MRN_3F90]", category: "MRN", confidence: 1 },
    ],
    uploadedAt: "2026-10-30T09:15:00.000Z",
    ...overrides,
  };
}

class InMemoryChunkStore implements DocumentChunkStore {
  readonly docs = new Map<string, DocumentChunkDoc>();

  async replaceForDocument(documentId: string, chunks: DocumentChunkDoc[]): Promise<number> {
    for (const [id, doc] of this.docs) {
      if (doc.documentId === documentId) {
        this.docs.delete(id);
      }
    }
    for (const chunk of chunks) {
      if (this.docs.has(chunk._id)) {
        throw new Error(`duplicate _id ${chunk._id}`);
      }
      this.docs.set(chunk._id, chunk);
    }
    return chunks.length;
  }

  forDocument(documentId: string): DocumentChunkDoc[] {
    return [...this.docs.values()]
      .filter((doc) => doc.documentId === documentId)
      .sort((a, b) => a.chunkIndex - b.chunkIndex);
  }
}

/**
 * Stands in for the BullMQ queue (no Redis in CI). `enqueue` only records the
 * job, exactly like `Queue.add`; `drain()` plays the worker's role.
 */
class InMemoryIngestionQueue implements IngestionQueue {
  private readonly jobs = new Map<
    string,
    { data: IngestionJobData; status: IngestionJobStatus }
  >();

  async enqueue(data: IngestionJobData): Promise<string> {
    const jobId = randomUUID();
    this.jobs.set(jobId, {
      data,
      status: { jobId, documentId: data.documentId, state: "queued", progress: 0, attemptsMade: 0 },
    });
    return jobId;
  }

  async getStatus(jobId: string): Promise<IngestionJobStatus | null> {
    return this.jobs.get(jobId)?.status ?? null;
  }

  get size(): number {
    return this.jobs.size;
  }

  async drain(deps: IngestionDeps): Promise<void> {
    for (const job of this.jobs.values()) {
      if (job.status.state !== "queued") {
        continue;
      }
      job.status = { ...job.status, state: "processing" };
      try {
        const result: IngestionJobResult = await processIngestionJob(job.data, deps, async (p) => {
          job.status = { ...job.status, progress: p };
        });
        job.status = { ...job.status, state: "completed", progress: 100, attemptsMade: 1, result };
      } catch (error) {
        job.status = {
          ...job.status,
          state: "failed",
          attemptsMade: 1,
          failedReason: (error as Error).message,
        };
      }
    }
  }
}

function spyingVoyage(): VoyageService & { calls: number } {
  const inner = createMockVoyageService();
  const spy = {
    ...inner,
    calls: 0,
    async embedDocumentChunks(chunks: readonly string[]) {
      spy.calls += 1;
      return inner.embedDocumentChunks(chunks);
    },
  };
  return spy;
}

function cosine(a: number[], b: number[]): number {
  return a.reduce((sum, value, i) => sum + value * (b[i] ?? 0), 0);
}

// ---------------------------------------------------------------------------
// POST /api/v1/documents and job polling
// ---------------------------------------------------------------------------

describe("documents routes", () => {
  let queue: InMemoryIngestionQueue;
  let store: InMemoryChunkStore;
  let voyage: ReturnType<typeof spyingVoyage>;
  let app: Express;
  let logLines: string[];

  beforeEach(() => {
    queue = new InMemoryIngestionQueue();
    store = new InMemoryChunkStore();
    voyage = spyingVoyage();
    logLines = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        logLines.push(chunk.toString());
        callback();
      },
    });
    app = createApp({
      env: { CORS_ORIGINS: ["http://localhost:5173"], BODY_LIMIT: "1mb" },
      logger: createLogger({ LOG_LEVEL: "info", NODE_ENV: "test" }, sink),
      checkDb: async () => true,
      registerApiRoutes: (api) => {
        api.use(createDocumentsRouter({ queue }));
      },
    });
  });

  it("answers 202 Accepted with a polling URL and defers all work to the queue", async () => {
    const body = upload();
    const res = await request(app).post("/api/v1/documents").send(body);

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ documentId: body.documentId, state: "queued" });
    expect(res.body.jobId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.statusUrl).toBe(`/api/v1/documents/jobs/${res.body.jobId}`);
    expect(res.headers.location).toBe(res.body.statusUrl);
    expect(queue.size).toBe(1);
    // Nothing slow ran on the request path.
    expect(voyage.calls).toBe(0);
    expect(store.docs.size).toBe(0);
  });

  it("responds to uploads in under 25ms", async () => {
    // Warm up the router, body parser and guard once before timing.
    await request(app).post("/api/v1/documents").send(upload());

    const timings: number[] = [];
    for (let i = 0; i < 15; i += 1) {
      const started = performance.now();
      const res = await request(app).post("/api/v1/documents").send(upload());
      timings.push(performance.now() - started);
      expect(res.status).toBe(202);
    }
    timings.sort((a, b) => a - b);
    const median = timings[Math.floor(timings.length / 2)] ?? Infinity;
    expect(median).toBeLessThan(25);
  });

  it("reports job progress through to completion with the stored chunk count", async () => {
    const res = await request(app).post("/api/v1/documents").send(upload());
    const statusUrl = res.body.statusUrl as string;

    const queued = await request(app).get(statusUrl);
    expect(queued.status).toBe(200);
    expect(queued.body).toMatchObject({ state: "queued", progress: 0 });

    await queue.drain({ voyage, chunkStore: store });

    const done = await request(app).get(statusUrl);
    expect(done.body.state).toBe("completed");
    expect(done.body.progress).toBe(100);
    expect(done.body.result.chunkCount).toBe(store.forDocument(res.body.documentId).length);
    expect(done.body.result.embeddingModel).toBe("voyage-context-3-mock");
  });

  it("returns 404 for unknown or malformed job ids", async () => {
    expect((await request(app).get(`/api/v1/documents/jobs/${randomUUID()}`)).status).toBe(404);
    const malformed = await request(app).get("/api/v1/documents/jobs/not-a-job");
    expect(malformed.status).toBe(404);
    expect(malformed.body.error).toBe("JOB_NOT_FOUND");
  });

  it("rejects uploads that fail the shared schema with 400 and enqueues nothing", async () => {
    const res = await request(app)
      .post("/api/v1/documents")
      .send({ ...upload(), documentId: "doc-1", sanitizedContent: "" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("VALIDATION_ERROR");
    expect(res.body.issues.map((issue: { path: string }) => issue.path)).toEqual(
      expect.arrayContaining(["documentId", "sanitizedContent"]),
    );
    expect(queue.size).toBe(0);
  });

  it("rejects an entity reference that is not a placeholder token", async () => {
    const res = await request(app)
      .post("/api/v1/documents")
      .send(upload({ entities: [{ token: "Jane Doe", category: "PER", confidence: 0.9 }] }));

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain("Jane Doe");
    expect(queue.size).toBe(0);
  });

  it("blocks raw PII in an upload with 422 before anything is queued", async () => {
    const res = await request(app)
      .post("/api/v1/documents")
      .send(upload({ sanitizedContent: `${DISCHARGE_SUMMARY}\nPatient SSN 123-45-6789.` }));

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("ZERO_TRUST_VIOLATION");
    expect(JSON.stringify(res.body)).not.toContain("123-45-6789");
    expect(logLines.join("")).not.toContain("123-45-6789");
    expect(queue.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Ingestion job body
// ---------------------------------------------------------------------------

describe("processIngestionJob", () => {
  it("chunks, embeds and stores sanitized chunks with stable ids", async () => {
    const store = new InMemoryChunkStore();
    const data = upload();
    const progress: number[] = [];

    const result = await processIngestionJob(
      data,
      { voyage: createMockVoyageService(), chunkStore: store, now: () => new Date("2026-10-30T10:00:00Z") },
      async (p) => {
        progress.push(p);
      },
    );

    const docs = store.forDocument(data.documentId);
    expect(result.chunkCount).toBe(docs.length);
    expect(docs.map((d) => d.sectionTitle)).toEqual([
      "Discharge Summary",
      "Discharge Summary > Medications",
      "Discharge Summary > Follow-up",
    ]);
    for (const doc of docs) {
      expect(doc._id).toBe(chunkIdFor(data.documentId, doc.chunkIndex));
      expect(doc.embedding).toHaveLength(EMBEDDING_DIMENSIONS);
      expect(doc.embeddingModel).toBe("voyage-context-3-mock");
      expect(doc.fileName).toBe("discharge-summary.md");
      expect(doc.createdAt.toISOString()).toBe("2026-10-30T10:00:00.000Z");
    }
    expect(docs[1]?.placeholderTokens).toEqual(["[PER_4B21]", "[PHONE_7E0D]"]);
    expect(progress).toEqual([25, 75, 100]);
  });

  it("is idempotent when a job is retried", async () => {
    const store = new InMemoryChunkStore();
    const data = upload();
    const deps = { voyage: createMockVoyageService(), chunkStore: store };

    await processIngestionJob(data, deps);
    const firstIds = store.forDocument(data.documentId).map((d) => d._id);
    await processIngestionJob(data, deps);

    expect(store.forDocument(data.documentId).map((d) => d._id)).toEqual(firstIds);
    expect(store.docs.size).toBe(firstIds.length);
  });

  it("refuses to embed or store a chunk carrying raw PII, without retrying", async () => {
    const store = new InMemoryChunkStore();
    const voyage = spyingVoyage();
    const data = upload({ sanitizedContent: "Reach the patient at jane.doe@example.org." });

    const failure = processIngestionJob(data, { voyage, chunkStore: store });
    await expect(failure).rejects.toBeInstanceOf(UnrecoverableError);
    await expect(failure).rejects.not.toThrow(/jane\.doe/);
    expect(voyage.calls).toBe(0);
    expect(store.docs.size).toBe(0);
  });

  it("rejects a document with no text content", async () => {
    await expect(
      processIngestionJob(upload({ sanitizedContent: "  \n\n " }), {
        voyage: createMockVoyageService(),
        chunkStore: new InMemoryChunkStore(),
      }),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it("propagates Voyage failures so BullMQ can retry, storing nothing", async () => {
    const store = new InMemoryChunkStore();
    const failing: VoyageService = {
      ...createMockVoyageService(),
      embedDocumentChunks: async () => {
        throw new VoyageApiError("contextualizedembeddings", 503);
      },
    };

    const failure = processIngestionJob(upload(), { voyage: failing, chunkStore: store });
    await expect(failure).rejects.toBeInstanceOf(VoyageApiError);
    await expect(failure).rejects.not.toBeInstanceOf(UnrecoverableError);
    expect(store.docs.size).toBe(0);
  });

  it("derives RFC 4122 shaped chunk ids", () => {
    const id = chunkIdFor("2c1f6c1e-6a0b-4c43-9a8d-0d2f8d1f2b11", 3);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(chunkIdFor("2c1f6c1e-6a0b-4c43-9a8d-0d2f8d1f2b11", 4)).not.toBe(id);
  });
});

// ---------------------------------------------------------------------------
// Semantic chunker
// ---------------------------------------------------------------------------

describe("chunkSanitizedDocument", () => {
  it("builds heading paths and resets them when a higher-level heading appears", () => {
    const chunks = chunkSanitizedDocument(
      "# Report\n\nIntro.\n\n## Labs\n\nCBC normal.\n\n### Notes\n\nNone.\n\n# Appendix\n\nA.",
    );
    expect(chunks.map((c) => c.sectionTitle)).toEqual([
      "Report",
      "Report > Labs",
      "Report > Labs > Notes",
      "Appendix",
    ]);
    expect(chunks.map((c) => c.chunkIndex)).toEqual([0, 1, 2, 3]);
  });

  it("uses the fallback title for text before any heading and ignores headings in code fences", () => {
    const chunks = chunkSanitizedDocument("Preamble text.\n\n```\n# not a heading\n```", {
      fallbackTitle: "intake.txt",
    });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.sectionTitle).toBe("intake.txt");
    expect(chunks[0]?.sanitizedContent).toContain("# not a heading");
  });

  it("keeps chunks within the size budget and never splits a placeholder token", () => {
    const tokens = Array.from({ length: 60 }, (_, i) => `[PER_${i.toString(16).toUpperCase().padStart(4, "0")}]`);
    const paragraph = tokens
      .map((token, i) => `Visit ${i} was attended by ${token} and reviewed by [ORG_ABCD]`)
      .join(". ");
    const text = `# Visits\n\n${paragraph}.\n\n${"x".repeat(50)}`;

    const chunks = chunkSanitizedDocument(text, { maxChars: 300, minChars: 20 });

    expect(chunks.length).toBeGreaterThan(5);
    for (const chunk of chunks) {
      expect(chunk.sanitizedContent.length).toBeLessThanOrEqual(300);
      // Any bracket fragment must be a complete token.
      const fragments = chunk.sanitizedContent.match(/\[[^\]\s]*\]?|\b[A-Z]+_[0-9A-F]{1,4}\]/g) ?? [];
      for (const fragment of fragments) {
        expect(fragment).toMatch(/^\[(PER|ORG)_[0-9A-F]{4}\]$/);
      }
    }
    const allTokens = new Set(chunks.flatMap((c) => c.placeholderTokens));
    for (const token of tokens) {
      expect(allTokens.has(token)).toBe(true);
    }
  });

  it("hard-splits a run with no sentence boundary around tokens", () => {
    const words = Array.from({ length: 80 }, (_, i) => (i % 7 === 0 ? "[LOC_0A9F]" : "ward"));
    const chunks = chunkSanitizedDocument(words.join(" "), { maxChars: 64, minChars: 1 });

    for (const chunk of chunks) {
      expect(chunk.sanitizedContent.length).toBeLessThanOrEqual(64);
      expect(chunk.sanitizedContent).not.toMatch(/\[LOC_[0-9A-F]{0,3}$|^[0-9A-F]{0,4}\]/);
    }
    expect(chunks.map((c) => c.sanitizedContent).join(" ")).toBe(words.join(" "));
  });

  it("merges a tiny trailing chunk into its predecessor", () => {
    const body = `${"Long paragraph sentence. ".repeat(10).trim()}\n\nOk.`;
    const chunks = chunkSanitizedDocument(body, { maxChars: 260, minChars: 50 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.sanitizedContent.endsWith("Ok.")).toBe(true);
  });

  it("returns no chunks for blank input", () => {
    expect(chunkSanitizedDocument(" \n\n ")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Voyage client
// ---------------------------------------------------------------------------

describe("voyage service (mock mode)", () => {
  const voyage = createVoyageService({ apiKey: "mock" });

  it("selects the offline implementation for VOYAGE_API_KEY=mock", () => {
    expect(voyage.mode).toBe("mock");
  });

  it("produces deterministic, unit-length 1024-d vectors", async () => {
    const [a] = await voyage.embedDocumentChunks(["Amoxicillin 500 mg for [PER_89A1]"]);
    const [b] = await createMockVoyageService().embedDocumentChunks([
      "Amoxicillin 500 mg for [PER_89A1]",
    ]);
    expect(a).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(a).toEqual(b);
    expect(Math.hypot(...(a ?? []))).toBeCloseTo(1, 6);
  });

  it("places related text closer than unrelated text", async () => {
    const [meds, billing] = await voyage.embedDocumentChunks([
      "Amoxicillin 500 mg three times daily for pneumonia",
      "Invoice settled by bank transfer to the billing office",
    ]);
    const query = await voyage.embedQuery("amoxicillin dose for pneumonia");
    expect(cosine(query, meds ?? [])).toBeGreaterThan(cosine(query, billing ?? []));
  });

  it("contextualizes chunks: the same text embeds differently in different documents", async () => {
    const [inA] = await voyage.embedDocumentChunks(["Dose adjusted.", "Renal function declining."]);
    const [inB] = await voyage.embedDocumentChunks(["Dose adjusted.", "Invoice overdue."]);
    expect(inA).not.toEqual(inB);
    expect(cosine(inA ?? [], inB ?? [])).toBeGreaterThan(0.8);
  });

  it("reranks by query overlap, matching placeholder tokens exactly", async () => {
    const results = await voyage.rerank(
      "follow-up for [MRN_3F90]",
      ["Billing notes.", "Follow-up booked for [MRN_3F90].", "Follow-up booked for [MRN_1111]."],
      2,
    );
    expect(results).toHaveLength(2);
    expect(results[0]?.index).toBe(1);
    expect(results[0]?.relevanceScore).toBe(1);
  });
});

describe("voyage service (live client)", () => {
  function fakeFetch(
    respond: (url: string, body: Record<string, unknown>) => { status?: number; json?: unknown },
  ) {
    return vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const { status = 200, json = {} } = respond(String(input), body);
      return new Response(JSON.stringify(json), { status });
    });
  }

  it("calls contextualizedembeddings with voyage-context-3 and reorders results by index", async () => {
    const fetch = fakeFetch((_url, body) => {
      const inputs = body.inputs as string[][];
      return {
        json: {
          data: inputs
            .map((group, g) => ({
              index: g,
              data: group.map((_c, i) => ({ index: i, embedding: [g, i] })).reverse(),
            }))
            .reverse(),
        },
      };
    });
    const voyage = createVoyageService({ apiKey: "va-test", fetch, dimensions: 2 });

    const vectors = await voyage.embedDocumentChunks(["a", "b", "c"]);

    expect(voyage.mode).toBe("live");
    expect(vectors).toEqual([[0, 0], [0, 1], [0, 2]]);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("https://api.voyageai.com/v1/contextualizedembeddings");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer va-test");
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "voyage-context-3",
      inputs: [["a", "b", "c"]],
      input_type: "document",
      output_dimension: 2,
    });
  });

  it("embeds queries with input_type=query", async () => {
    const fetch = fakeFetch(() => ({
      json: { data: [{ index: 0, data: [{ index: 0, embedding: [0.6, 0.8] }] }] },
    }));
    const voyage = createVoyageService({ apiKey: "va-test", fetch, dimensions: 2 });

    expect(await voyage.embedQuery("dose")).toEqual([0.6, 0.8]);
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      inputs: [["dose"]],
      input_type: "query",
    });
  });

  it("calls rerank-2.5 and maps relevance scores", async () => {
    const fetch = fakeFetch(() => ({
      json: { data: [{ index: 2, relevance_score: 0.91 }, { index: 0, relevance_score: 0.4 }] },
    }));
    const voyage = createVoyageService({ apiKey: "va-test", fetch });

    const results = await voyage.rerank("q", ["x", "y", "z"], 2);

    expect(results).toEqual([
      { index: 2, relevanceScore: 0.91 },
      { index: 0, relevanceScore: 0.4 },
    ]);
    expect(fetch.mock.calls[0]?.[0]).toBe("https://api.voyageai.com/v1/rerank");
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      model: "rerank-2.5",
      query: "q",
      documents: ["x", "y", "z"],
      top_k: 2,
    });
  });

  it("raises VoyageApiError with the status and without echoing the response body", async () => {
    const fetch = fakeFetch(() => ({ status: 429, json: { detail: "echo: [PER_89A1]" } }));
    const voyage = createVoyageService({ apiKey: "va-test", fetch });

    const failure = voyage.embedDocumentChunks(["a"]);
    await expect(failure).rejects.toBeInstanceOf(VoyageApiError);
    await expect(failure).rejects.toMatchObject({ status: 429 });
    await expect(failure).rejects.not.toThrow(/PER_89A1/);
  });

  it("splits oversized documents into several context windows", async () => {
    const fetch = fakeFetch((_url, body) => ({
      json: {
        data: (body.inputs as string[][]).map((group, g) => ({
          index: g,
          data: group.map((_c, i) => ({ index: i, embedding: [1] })),
        })),
      },
    }));
    const voyage = createVoyageService({ apiKey: "va-test", fetch, dimensions: 1 });
    const chunks = Array.from({ length: 10 }, () => "x".repeat(40_000));

    const vectors = await voyage.embedDocumentChunks(chunks);

    expect(vectors).toHaveLength(10);
    const requests = fetch.mock.calls.map(
      (call) => JSON.parse(String(call[1]?.body)) as { inputs: string[][] },
    );
    for (const { inputs } of requests) {
      for (const window of inputs) {
        expect(window.join("").length).toBeLessThanOrEqual(96_000);
      }
      expect(inputs.flat().join("").length).toBeLessThanOrEqual(360_000);
    }
    expect(requests.flatMap((r) => r.inputs.flat())).toHaveLength(10);
  });

  it("groups items greedily by character budget", () => {
    expect(groupByCharBudget(["aaa", "bb", "cccc", "d"], 5)).toEqual([["aaa", "bb"], ["cccc", "d"]]);
    expect(groupByCharBudget(["toolongitem"], 5)).toEqual([["toolongitem"]]);
  });
});
