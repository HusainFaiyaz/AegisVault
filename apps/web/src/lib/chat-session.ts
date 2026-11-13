import { hasRawPiiLeakage } from "@aegis/shared";
import type { RedactionOutcome } from "../hooks/useZeroTrustScrubber.js";
import {
  parseChatStreamEvent,
  ProtocolError,
  type ChatHistoryTurn,
  type ChatStreamRequestBody,
  type DoneEvent,
  type GroundingEvent,
  type RetrievalEvent,
} from "./chat-protocol.js";
import {
  createRehydrationTransformStream,
  type EntityLookupMap,
  type StreamSegment,
} from "./stream-rehydrator.js";
import { ApiError, ZeroTrustEgressError, type WireClient } from "./wire-client.js";

export const CHAT_STREAM_PATH = "/api/v1/chat/stream";
/** Mirrors the API's `MAX_HISTORY_TURNS`. */
export const MAX_HISTORY_TURNS = 20;

export type AssistantPhase =
  | "scrubbing"
  | "retrieving"
  | "streaming"
  | "done"
  | "failed"
  | "aborted";

/** The assistant side of one turn, rebuilt immutably on every update. */
export interface AssistantDraft {
  phase: AssistantPhase;
  /** Re-hydrated segments, in arrival order. */
  segments: StreamSegment[];
  /** The exact token text the API streamed (placeholders intact). */
  wireText: string;
  retrieval: RetrievalEvent | null;
  grounding: GroundingEvent | null;
  done: DoneEvent | null;
  error: string | null;
}

export interface ChatTurnDeps {
  /** Local scrubber: the question is pseudonymised before anything is sent. */
  scrub: (text: string) => Promise<RedactionOutcome>;
  /** Decrypted token -> real value map, read after the question is scrubbed. */
  loadLookup: () => Promise<EntityLookupMap>;
  client: Pick<WireClient, "postEventStream">;
}

export interface ChatTurnInput {
  question: string;
  documentIds: readonly string[];
  history: readonly ChatHistoryTurn[];
  signal?: AbortSignal;
}

export interface ChatTurnCallbacks {
  onQueryRedacted: (outcome: RedactionOutcome) => void;
  onDraft: (draft: AssistantDraft) => void;
}

export function emptyDraft(): AssistantDraft {
  return {
    phase: "scrubbing",
    segments: [],
    wireText: "",
    retrieval: null,
    grounding: null,
    done: null,
    error: null,
  };
}

const API_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  ZERO_TRUST_VIOLATION: "The API rejected the request as containing raw PII (HTTP 422).",
  RATE_LIMITED: "Rate limit reached. Wait a few seconds and ask again.",
  VALIDATION_ERROR: "The API rejected the request shape (HTTP 400).",
  CONTEXT_INTEGRITY_VIOLATION:
    "Retrieved context failed the server's zero-trust re-scan, so nothing was sent to the model.",
  STREAM_FAILED: "The model stream failed part-way. The partial answer is shown above.",
};

/** Turns any failure into a message that is safe to show (no payload echo). */
export function describeFailure(error: unknown): string {
  if (error instanceof ZeroTrustEgressError) {
    return `Blocked in the browser before sending: the payload still contained raw ${error.categories.join(", ")}.`;
  }
  if (error instanceof ApiError) {
    const known = API_ERROR_MESSAGES[error.code];
    const trace = error.traceId === null ? "" : ` Trace ${error.traceId}.`;
    return `${known ?? `Request failed: ${error.code}.`}${trace}`;
  }
  if (error instanceof ProtocolError) return `Unexpected response from the API: ${error.message}.`;
  if (error instanceof TypeError) return "Cannot reach the API. Is apps/api running?";
  return "Something went wrong. Check the Network Proof drawer for details.";
}

/**
 * History sent with a follow-up question. Every turn is already tokenised;
 * any turn that still trips the guard (e.g. a model answer that produced a
 * raw-PII-shaped string) is dropped rather than letting it block the
 * request or leave the browser.
 */
export function buildHistory(turns: readonly ChatHistoryTurn[]): ChatHistoryTurn[] {
  return turns
    .filter((turn) => turn.content.trim().length > 0 && !hasRawPiiLeakage(turn.content))
    .slice(-MAX_HISTORY_TURNS);
}

function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || (error instanceof DOMException && error.name === "AbortError");
}

/**
 * Runs one copilot turn:
 *   1. scrub the question locally (it can contain PII too),
 *   2. send the tokenised question through the guarded wire client,
 *   3. pipe `delta` events through the sliding-window re-hydrator so
 *      placeholders split across chunks resolve to real values in place,
 *   4. attach retrieval, grounding and latency events as they arrive.
 */
export async function runChatTurn(
  input: ChatTurnInput,
  deps: ChatTurnDeps,
  callbacks: ChatTurnCallbacks,
): Promise<AssistantDraft> {
  let draft = emptyDraft();
  const emit = (patch: Partial<AssistantDraft>): void => {
    draft = { ...draft, ...patch };
    callbacks.onDraft(draft);
  };
  emit({});

  let outcome: RedactionOutcome;
  try {
    outcome = await deps.scrub(input.question);
  } catch {
    emit({ phase: "failed", error: "Local scrubbing failed, so nothing was sent." });
    return draft;
  }
  callbacks.onQueryRedacted(outcome);
  if (input.signal?.aborted === true) {
    emit({ phase: "aborted" });
    return draft;
  }

  const lookup = await deps.loadLookup();
  const rehydrator = createRehydrationTransformStream(lookup);
  const writer = rehydrator.writable.getWriter();
  const reader = rehydrator.readable.getReader();
  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      emit({ segments: [...draft.segments, value] });
    }
  })();

  const body: ChatStreamRequestBody = { query: outcome.redactedText };
  if (input.documentIds.length > 0) body.documentIds = [...input.documentIds];
  const history = buildHistory(input.history);
  if (history.length > 0) body.history = history;

  emit({ phase: "retrieving" });
  let failure: unknown = null;
  try {
    const options: Parameters<WireClient["postEventStream"]>[2] = {
      label: "Chat stream",
      onMessage: (message) => {
        const event = parseChatStreamEvent(message.event, message.data);
        if (event === null) return;
        switch (event.type) {
          case "retrieval":
            emit({ retrieval: event.data, phase: "streaming" });
            return;
          case "delta":
            draft = { ...draft, wireText: draft.wireText + event.data.text };
            // Not awaited: writes queue in order and the pump drains them.
            writer.write(event.data.text).catch(() => undefined);
            return;
          case "grounding":
            emit({ grounding: event.data });
            return;
          case "done":
            emit({ done: event.data });
            return;
          case "error":
            emit({ error: describeFailure(new ApiError(200, event.data.error, event.data.traceId)) });
            return;
        }
      },
    };
    if (input.signal !== undefined) options.signal = input.signal;
    await deps.client.postEventStream(CHAT_STREAM_PATH, body, options);
  } catch (error) {
    failure = error;
  }

  // Flush: a trailing `[` held by the lookahead buffer is released as text.
  await writer.close().catch(() => undefined);
  await pump;

  if (failure !== null) {
    if (isAbort(failure, input.signal)) emit({ phase: "aborted" });
    else emit({ phase: "failed", error: describeFailure(failure) });
  } else {
    emit({ phase: draft.error === null ? "done" : "failed" });
  }
  return draft;
}
