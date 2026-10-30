import { createHash, randomUUID } from "node:crypto";
import { Queue, UnrecoverableError, Worker, type ConnectionOptions, type Job } from "bullmq";
import type { Logger } from "pino";
import { detectRawPiiLeakage, type SanitizedDocumentUpload } from "@aegis/shared";
import type { DocumentChunkDoc, DocumentChunkStore } from "../models/document-chunk.model.js";
import { chunkSanitizedDocument, type ChunkerOptions } from "../services/chunker.service.js";
import type { VoyageService } from "../services/voyage.service.js";

/**
 * BullMQ ingestion pipeline. `POST /api/v1/documents` only enqueues; this
 * worker does the slow part (chunking, `voyage-context-3` embeddings, MongoDB
 * writes) in the background so the upload can answer `202` immediately.
 */

export const INGESTION_QUEUE_NAME = "document-ingestion";
const INGESTION_JOB_NAME = "ingest-document";

export type IngestionJobData = SanitizedDocumentUpload;

export interface IngestionJobResult {
  documentId: string;
  chunkCount: number;
  embeddingModel: string;
  durationMs: number;
}

export type IngestionJobState = "queued" | "processing" | "completed" | "failed";

export interface IngestionJobStatus {
  jobId: string;
  documentId: string;
  state: IngestionJobState;
  progress: number;
  attemptsMade: number;
  result?: IngestionJobResult;
  failedReason?: string;
}

/** Queue port used by the documents router; the BullMQ adapter is below. */
export interface IngestionQueue {
  enqueue(data: IngestionJobData): Promise<string>;
  getStatus(jobId: string): Promise<IngestionJobStatus | null>;
}

export interface IngestionDeps {
  voyage: VoyageService;
  chunkStore: DocumentChunkStore;
  chunker?: ChunkerOptions;
  now?: () => Date;
}

/** Raised for input that would fail identically on every retry. */
export class IngestionRejectedError extends UnrecoverableError {
  constructor(message: string) {
    super(message);
    this.name = "IngestionRejectedError";
  }
}

/** Stable UUID (v5 layout) per document chunk, so retries reuse the same ids. */
export function chunkIdFor(documentId: string, chunkIndex: number): string {
  const hex = createHash("sha256").update(`${documentId}:${chunkIndex}`).digest("hex");
  const variant = ((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${variant}${hex.slice(18, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

/**
 * The job body, independent of BullMQ so it can be tested without Redis.
 * Re-checks every chunk for raw PII before anything is embedded or stored:
 * the ingress guard should already have caught it, but a sanitized-only
 * collection is the invariant, so the last write path enforces it too.
 */
export async function processIngestionJob(
  data: IngestionJobData,
  deps: IngestionDeps,
  reportProgress: (percent: number) => Promise<void> = async () => {},
): Promise<IngestionJobResult> {
  const startedAt = Date.now();
  const now = deps.now ?? (() => new Date());

  const chunks = chunkSanitizedDocument(data.sanitizedContent, {
    fallbackTitle: data.fileName,
    ...deps.chunker,
  });
  if (chunks.length === 0) {
    throw new IngestionRejectedError("Document has no text content to ingest");
  }
  for (const chunk of chunks) {
    const leak = [
      ...detectRawPiiLeakage(chunk.sanitizedContent),
      ...detectRawPiiLeakage(chunk.sectionTitle),
    ];
    if (leak.length > 0) {
      throw new IngestionRejectedError(
        `Chunk ${chunk.chunkIndex} contains unredacted ${[...new Set(leak.map((f) => f.category))].join(", ")}`,
      );
    }
  }
  await reportProgress(25);

  const embeddings = await deps.voyage.embedDocumentChunks(
    chunks.map((chunk) => `${chunk.sectionTitle}\n\n${chunk.sanitizedContent}`),
  );
  await reportProgress(75);

  const createdAt = now();
  const docs: DocumentChunkDoc[] = chunks.map((chunk, i) => {
    const embedding = embeddings[i];
    if (!embedding) {
      throw new Error(`Missing embedding for chunk ${chunk.chunkIndex}`);
    }
    return {
      _id: chunkIdFor(data.documentId, chunk.chunkIndex),
      documentId: data.documentId,
      fileName: data.fileName,
      chunkIndex: chunk.chunkIndex,
      sectionTitle: chunk.sectionTitle,
      sanitizedContent: chunk.sanitizedContent,
      placeholderTokens: chunk.placeholderTokens,
      embedding,
      embeddingModel: deps.voyage.embeddingModel,
      createdAt,
    };
  });
  const chunkCount = await deps.chunkStore.replaceForDocument(data.documentId, docs);
  await reportProgress(100);

  return {
    documentId: data.documentId,
    chunkCount,
    embeddingModel: deps.voyage.embeddingModel,
    durationMs: Date.now() - startedAt,
  };
}

// ---------------------------------------------------------------------------
// BullMQ adapters
// ---------------------------------------------------------------------------

type IngestionJob = Job<IngestionJobData, IngestionJobResult>;

function toPublicState(state: string): IngestionJobState {
  switch (state) {
    case "active":
      return "processing";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      return "queued";
  }
}

export function createBullIngestionQueue(
  connection: ConnectionOptions,
): IngestionQueue & { close(): Promise<void> } {
  const queue = new Queue<IngestionJobData, IngestionJobResult>(INGESTION_QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 2_000 },
      removeOnComplete: { age: 24 * 3600, count: 1_000 },
      removeOnFail: { age: 7 * 24 * 3600 },
    },
  });

  return {
    async enqueue(data) {
      const job = await queue.add(INGESTION_JOB_NAME, data, { jobId: randomUUID() });
      return job.id ?? "";
    },

    async getStatus(jobId) {
      const job: IngestionJob | undefined = await queue.getJob(jobId);
      if (!job) {
        return null;
      }
      const state = toPublicState(await job.getState());
      const progress = typeof job.progress === "number" ? job.progress : 0;
      return {
        jobId,
        documentId: job.data.documentId,
        state,
        progress: state === "completed" ? 100 : progress,
        attemptsMade: job.attemptsMade,
        ...(state === "completed" && job.returnvalue ? { result: job.returnvalue } : {}),
        ...(state === "failed" && job.failedReason ? { failedReason: job.failedReason } : {}),
      };
    },

    close: () => queue.close(),
  };
}

export interface IngestionWorkerOptions {
  connection: ConnectionOptions;
  deps: IngestionDeps;
  logger: Logger;
  concurrency?: number;
}

export function createIngestionWorker({
  connection,
  deps,
  logger,
  concurrency = 2,
}: IngestionWorkerOptions): Worker<IngestionJobData, IngestionJobResult> {
  const worker = new Worker<IngestionJobData, IngestionJobResult>(
    INGESTION_QUEUE_NAME,
    (job) => processIngestionJob(job.data, deps, (percent) => job.updateProgress(percent)),
    { connection, concurrency },
  );

  // Log ids and counts only; job data is sanitized but still not log material.
  worker.on("completed", (job, result) => {
    logger.info(
      { jobId: job.id, documentId: result.documentId, chunkCount: result.chunkCount, durationMs: result.durationMs },
      "document ingested",
    );
  });
  worker.on("failed", (job, error) => {
    logger.error(
      { jobId: job?.id, documentId: job?.data.documentId, attemptsMade: job?.attemptsMade, errName: error.name, reason: error.message },
      "document ingestion failed",
    );
  });
  worker.on("error", (error) => {
    logger.error({ err: error }, "ingestion worker error");
  });

  return worker;
}
