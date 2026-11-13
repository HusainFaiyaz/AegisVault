import { EntityCategoryEnum } from "@aegis/shared";
import { z } from "zod";

/**
 * Client-side contract for `POST /api/v1/chat/stream` (Day 8) and the
 * document ingestion endpoints (Day 6). The browser validates every event it
 * receives instead of trusting the wire; anything that fails to parse is
 * surfaced as a protocol error rather than rendered.
 */

export const CitationMarkerRegex = /^\[CIT-\d{2}\]$/;

export const StreamCitationSchema = z.object({
  chunkId: z.string(),
  documentId: z.string(),
  fileName: z.string(),
  sectionTitle: z.string(),
  sanitizedContent: z.string(),
  placeholderTokens: z.array(z.string()),
  citationMarker: z.string().regex(CitationMarkerRegex),
  score: z.number(),
  scoreDetails: z.record(z.string(), z.unknown()).optional(),
});
export type StreamCitation = z.infer<typeof StreamCitationSchema>;

export const RetrievalEventSchema = z.object({
  traceId: z.string(),
  promptVersion: z.string(),
  model: z.string(),
  citations: z.array(StreamCitationSchema),
  retrieval: z.object({
    fusionSource: z.string(),
    candidateCount: z.number(),
    timings: z.record(z.string(), z.number()),
  }),
});
export type RetrievalEvent = z.infer<typeof RetrievalEventSchema>;

export const DeltaEventSchema = z.object({ text: z.string() });

export const GroundingEventSchema = z.object({
  citedMarkers: z.array(z.string()),
  unusedCitations: z.array(z.string()),
  invalidCitations: z.array(z.string()),
  preservedTokens: z.array(z.string()),
  unknownTokens: z.array(z.string()),
  malformedTokens: z.array(z.string()),
  rawPiiCategories: z.array(EntityCategoryEnum),
  sentenceCount: z.number(),
  citedSentenceCount: z.number(),
  grounded: z.boolean(),
});
export type GroundingEvent = z.infer<typeof GroundingEventSchema>;

export const DoneEventSchema = z.object({
  traceId: z.string(),
  finishReason: z.string(),
  usage: z.object({
    inputTokens: z.number().nullable(),
    outputTokens: z.number().nullable(),
    totalTokens: z.number().nullable(),
  }),
  latency: z.object({
    retrievalMs: z.number(),
    timeToFirstTokenMs: z.number().nullable(),
    generationMs: z.number(),
    totalMs: z.number(),
  }),
});
export type DoneEvent = z.infer<typeof DoneEventSchema>;

export const StreamErrorEventSchema = z.object({
  error: z.string(),
  traceId: z.string(),
});

export type ChatStreamEvent =
  | { type: "retrieval"; data: RetrievalEvent }
  | { type: "delta"; data: z.infer<typeof DeltaEventSchema> }
  | { type: "grounding"; data: GroundingEvent }
  | { type: "done"; data: DoneEvent }
  | { type: "error"; data: z.infer<typeof StreamErrorEventSchema> };

export class ProtocolError extends Error {
  override name = "ProtocolError";
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new ProtocolError("Stream event data is not valid JSON");
  }
}

/** Validates one SSE message. Unknown event names return `null` (ignored). */
export function parseChatStreamEvent(
  event: string,
  rawData: string,
): ChatStreamEvent | null {
  const schemas = {
    retrieval: RetrievalEventSchema,
    delta: DeltaEventSchema,
    grounding: GroundingEventSchema,
    done: DoneEventSchema,
    error: StreamErrorEventSchema,
  } as const;

  // `hasOwn`, not `in`: an event named "toString" must not reach a prototype.
  if (!Object.hasOwn(schemas, event)) return null;
  const type = event as keyof typeof schemas;
  const parsed = schemas[type].safeParse(parseJson(rawData));
  if (!parsed.success) {
    throw new ProtocolError(`Malformed "${type}" event`);
  }
  return { type, data: parsed.data } as ChatStreamEvent;
}

export interface ChatHistoryTurn {
  role: "user" | "assistant";
  content: string;
}

export interface ChatStreamRequestBody {
  query: string;
  documentIds?: string[];
  history?: ChatHistoryTurn[];
}

export const DocumentAcceptedSchema = z.object({
  jobId: z.string(),
  documentId: z.string(),
  state: z.string(),
  statusUrl: z.string(),
  traceId: z.string(),
});
export type DocumentAccepted = z.infer<typeof DocumentAcceptedSchema>;

export const IngestionJobStateSchema = z.enum([
  "queued",
  "processing",
  "completed",
  "failed",
]);
export type IngestionJobState = z.infer<typeof IngestionJobStateSchema>;

export const IngestionJobStatusSchema = z.object({
  jobId: z.string(),
  documentId: z.string(),
  state: IngestionJobStateSchema,
  progress: z.number(),
  attemptsMade: z.number(),
  failedReason: z.string().optional(),
});
export type IngestionJobStatus = z.infer<typeof IngestionJobStatusSchema>;
