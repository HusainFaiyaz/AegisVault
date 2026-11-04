import { performance } from "node:perf_hooks";
import { streamText } from "ai";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { Router, type RequestHandler, type Response } from "express";
import { z } from "zod";
import {
  buildGroundedPrompt,
  evaluateGrounding,
  PromptRejectedError,
  PROMPT_VERSION,
  type GroundingReport,
} from "../services/prompt-builder.service.js";
import {
  MAX_QUERY_CHARS,
  RetrievalRejectedError,
  type RetrievalResult,
  type RetrievalScoreDetails,
  type RetrievalService,
} from "../services/retrieval.service.js";

/**
 * `POST /api/v1/chat/stream`: grounded, zero-knowledge chat over SSE.
 *
 * Mounted behind the PII guard, so the body is already free of raw PII. The
 * handler retrieves the top 5 reranked chunks (Day 7), builds a prompt that
 * pins placeholder tokens and `[CIT-XX]` markers, and streams the model's
 * answer with the Vercel AI SDK. The stream is plain Server-Sent Events:
 *
 *   event: retrieval  -> citations (5 reranked chunks) + retrieval latency
 *   event: delta      -> { text } model tokens, in order (repeated)
 *   event: grounding  -> citation / placeholder audit of the full answer
 *   event: done       -> finish reason, token usage, latency breakdown
 *   event: error      -> { error, traceId } if generation fails mid-stream
 *
 * Citations arrive before the first token, so the browser can render sources
 * and re-hydrate placeholders as text streams in.
 */

export const MAX_HISTORY_TURNS = 20;
export const MAX_DOCUMENT_SCOPE = 50;
export const DEFAULT_MAX_OUTPUT_TOKENS = 16_000;

export const ChatStreamRequestSchema = z
  .object({
    query: z.string().trim().min(1).max(MAX_QUERY_CHARS),
    documentIds: z.array(z.string().uuid()).min(1).max(MAX_DOCUMENT_SCOPE).optional(),
    history: z
      .array(
        z
          .object({
            role: z.enum(["user", "assistant"]),
            content: z.string().min(1).max(MAX_QUERY_CHARS * 4),
          })
          .strict(),
      )
      .max(MAX_HISTORY_TURNS)
      .optional(),
  })
  .strict();

export type ChatStreamRequest = z.infer<typeof ChatStreamRequestSchema>;

export interface StreamCitation {
  chunkId: string;
  documentId: string;
  fileName: string;
  sectionTitle: string;
  sanitizedContent: string;
  placeholderTokens: string[];
  citationMarker: string;
  score: number;
  scoreDetails: RetrievalScoreDetails;
}

export interface RetrievalEvent {
  traceId: string;
  promptVersion: string;
  model: string;
  citations: StreamCitation[];
  retrieval: {
    fusionSource: RetrievalResult["fusionSource"];
    candidateCount: number;
    timings: RetrievalResult["timings"];
  };
}

export interface DoneEvent {
  traceId: string;
  finishReason: string;
  usage: { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null };
  latency: {
    retrievalMs: number;
    /** Request received -> first model token written. Null if no token was produced. */
    timeToFirstTokenMs: number | null;
    generationMs: number;
    totalMs: number;
  };
}

export interface ChatRouterOptions {
  retrieval: RetrievalService;
  model: LanguageModelV4;
  modelId: string;
  /** Runs before validation; normally the Redis token-bucket limiter. */
  rateLimiter?: RequestHandler;
  maxOutputTokens?: number;
  now?: () => number;
}

function round(ms: number): number {
  return Math.round(ms * 100) / 100;
}

function writeEvent(res: Response, event: string, data: unknown): void {
  if (!res.writableEnded && !res.destroyed) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
}

function toStreamCitations(result: RetrievalResult): StreamCitation[] {
  return result.chunks.map((chunk) => ({
    chunkId: chunk.chunkId,
    documentId: chunk.documentId,
    fileName: chunk.fileName,
    sectionTitle: chunk.sectionTitle,
    sanitizedContent: chunk.sanitizedContent,
    placeholderTokens: chunk.placeholderTokens,
    citationMarker: chunk.citationMarker,
    score: chunk.score,
    scoreDetails: chunk.scoreDetails,
  }));
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

export function createChatRouter(options: ChatRouterOptions): Router {
  const router = Router();
  const now = options.now ?? (() => performance.now());
  const maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const handlers: RequestHandler[] = options.rateLimiter ? [options.rateLimiter] : [];

  router.post("/chat/stream", ...handlers, async (req, res) => {
    const startedAt = now();
    const traceId = res.locals.traceId as string;

    const parsed = ChatStreamRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "VALIDATION_ERROR",
        traceId,
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          code: issue.code,
          message: issue.message,
        })),
      });
      return;
    }
    const { query, documentIds, history } = parsed.data;

    // Retrieval and prompt assembly happen before any byte is streamed, so a
    // failure here is still an ordinary JSON error with a real status code.
    let retrieval: RetrievalResult;
    let prompt: ReturnType<typeof buildGroundedPrompt>;
    try {
      retrieval = await options.retrieval.retrieve(query, documentIds ? { documentIds } : {});
      prompt = buildGroundedPrompt({ query, history: history ?? [], sources: retrieval.chunks });
    } catch (error) {
      if (error instanceof RetrievalRejectedError || (error instanceof PromptRejectedError && error.source === "request")) {
        res.status(422).json({ error: "ZERO_TRUST_VIOLATION", traceId });
        return;
      }
      if (error instanceof PromptRejectedError) {
        // Raw PII came back from storage: refuse to send it to the model.
        req.log.error({ categories: error.categories }, "retrieved context failed the zero-trust re-scan");
        res.status(500).json({ error: "CONTEXT_INTEGRITY_VIOLATION", traceId });
        return;
      }
      throw error;
    }
    const retrievalDoneAt = now();

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const retrievalEvent: RetrievalEvent = {
      traceId,
      promptVersion: PROMPT_VERSION,
      model: options.modelId,
      citations: toStreamCitations(retrieval),
      retrieval: {
        fusionSource: retrieval.fusionSource,
        candidateCount: retrieval.candidateCount,
        timings: retrieval.timings,
      },
    };
    writeEvent(res, "retrieval", retrievalEvent);

    const abort = new AbortController();
    const onClose = (): void => {
      if (!res.writableFinished) {
        abort.abort();
      }
    };
    res.on("close", onClose);

    let answer = "";
    let firstTokenAt: number | null = null;
    let finishReason = "unknown";
    let usage: DoneEvent["usage"] = { inputTokens: null, outputTokens: null, totalTokens: null };
    let streamError: unknown = null;

    try {
      const result = streamText({
        model: options.model,
        instructions: prompt.system,
        messages: prompt.messages,
        maxOutputTokens,
        abortSignal: abort.signal,
        // Errors surface as `error` parts below; this only silences the SDK's
        // default console logging (provider errors can echo request bodies).
        onError: () => {},
      });

      for await (const part of result.fullStream) {
        if (part.type === "text-delta") {
          if (part.text.length === 0) {
            continue;
          }
          firstTokenAt ??= now();
          answer += part.text;
          writeEvent(res, "delta", { text: part.text });
        } else if (part.type === "error") {
          streamError = part.error;
          break;
        } else if (part.type === "abort") {
          break;
        } else if (part.type === "finish") {
          finishReason = part.finishReason;
          usage = {
            inputTokens: part.totalUsage.inputTokens ?? null,
            outputTokens: part.totalUsage.outputTokens ?? null,
            totalTokens: part.totalUsage.totalTokens ?? null,
          };
        }
      }
    } catch (error) {
      streamError = error;
    } finally {
      res.off("close", onClose);
    }

    if (abort.signal.aborted) {
      req.log.info({ chars: answer.length }, "chat stream aborted by client");
      res.end();
      return;
    }

    if (streamError !== null) {
      // Name only: provider error messages and bodies can quote the prompt.
      req.log.error({ errName: errorName(streamError), chars: answer.length }, "chat stream failed");
      writeEvent(res, "error", { error: "STREAM_FAILED", traceId });
      res.end();
      return;
    }

    const grounding: GroundingReport = evaluateGrounding(answer, {
      allowedTokens: prompt.allowedTokens,
      citationMarkers: prompt.citationMarkers,
    });
    writeEvent(res, "grounding", grounding);

    const finishedAt = now();
    const done: DoneEvent = {
      traceId,
      finishReason,
      usage,
      latency: {
        retrievalMs: round(retrievalDoneAt - startedAt),
        timeToFirstTokenMs: firstTokenAt === null ? null : round(firstTokenAt - startedAt),
        generationMs: round(finishedAt - retrievalDoneAt),
        totalMs: round(finishedAt - startedAt),
      },
    };
    writeEvent(res, "done", done);
    req.log.info(
      {
        citations: retrieval.chunks.length,
        cited: grounding.citedMarkers.length,
        grounded: grounding.grounded,
        finishReason,
        totalMs: done.latency.totalMs,
      },
      "chat stream completed",
    );
    res.end();
  });

  return router;
}
