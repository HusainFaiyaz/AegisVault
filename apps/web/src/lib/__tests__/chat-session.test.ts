import { detectRawPiiLeakage } from "@aegis/shared";
import { describe, expect, it, vi } from "vitest";
import type { RedactionOutcome } from "../../hooks/useZeroTrustScrubber.js";
import { buildHistory, CHAT_STREAM_PATH, runChatTurn, type AssistantDraft } from "../chat-session.js";
import { toRenderSegments } from "../segments.js";
import { createWireClient, type WireExchange, type WireRecorder } from "../wire-client.js";

const VAULT: ReadonlyMap<string, string> = new Map([
  ["[PER_89A1]", "Daniel Reyes"],
  ["[PER_C0DE]", "Dr. Amara Okafor"],
  ["[PHONE_4B21]", "(617) 555-0142"],
]);

/** Stand-in for the worker: replaces known raw values with their tokens. */
async function fakeScrub(text: string): Promise<RedactionOutcome> {
  let redactedText = text;
  const entities: RedactionOutcome["entities"] = [];
  for (const [token, value] of VAULT) {
    if (redactedText.includes(value)) {
      redactedText = redactedText.split(value).join(token);
      entities.push({ token, category: token.startsWith("[PER") ? "PER" : "PHONE", confidence: 0.98 });
    }
  }
  return { redactedText, entities };
}

const RETRIEVAL = {
  traceId: "trace-1",
  promptVersion: "aegis-grounded-v1",
  model: "mock-grounded",
  citations: [
    {
      chunkId: "c1",
      documentId: "d1",
      fileName: "cardiology-discharge-summary.txt",
      sectionTitle: "Plan",
      sanitizedContent: "[PER_89A1] starts apixaban 5 mg twice daily.",
      placeholderTokens: ["[PER_89A1]"],
      citationMarker: "[CIT-01]",
      score: 0.91,
      scoreDetails: { rerank: 0.91 },
    },
  ],
  retrieval: { fusionSource: "mock", candidateCount: 8, timings: { embedMs: 1, fusionMs: 2, rerankMs: 3 } },
};
const GROUNDING = {
  citedMarkers: ["[CIT-01]"],
  unusedCitations: [],
  invalidCitations: [],
  preservedTokens: ["[PER_89A1]", "[PHONE_4B21]"],
  unknownTokens: ["[PER_FFFF]"],
  malformedTokens: [],
  rawPiiCategories: [],
  sentenceCount: 2,
  citedSentenceCount: 2,
  grounded: false,
};
const DONE = {
  traceId: "trace-1",
  finishReason: "stop",
  usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
  latency: { retrievalMs: 12, timeToFirstTokenMs: 20, generationMs: 40, totalMs: 52 },
};

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** The answer streamed in awkward pieces: tokens and markers cut mid-way. */
const DELTAS = ["[PE", "R_89A1] starts apixaban [CI", "T-01]. Call [PHONE_4", "B21] or [PER_FF", "FF] [CIT-01]."];

function streamBody(chunks: readonly string[], opts: { failAfter?: number } = {}): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (opts.failAfter !== undefined && index === opts.failAfter) {
        controller.error(new TypeError("network dropped"));
        return;
      }
      const chunk = chunks[index++];
      if (chunk === undefined) controller.close();
      else controller.enqueue(encoder.encode(chunk));
    },
  });
}

/** Splits the full SSE text into fixed-size network chunks, ignoring event boundaries. */
function networkChunks(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

const HAPPY_STREAM =
  sse("retrieval", RETRIEVAL) + DELTAS.map((text) => sse("delta", { text })).join("") + sse("grounding", GROUNDING) + sse("done", DONE);

function harness(response: () => Response, scrub = fakeScrub) {
  const exchanges: WireExchange[] = [];
  const recorder: WireRecorder = {
    begin: (exchange) => void exchanges.push(exchange),
    update: (id, patch) => void Object.assign(exchanges.find((e) => e.id === id) ?? {}, patch),
    appendChunk: (id, chunk) => void exchanges.find((e) => e.id === id)?.chunks.push(chunk),
  };
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
    if (init?.signal?.aborted === true) throw new DOMException("aborted", "AbortError");
    return response();
  });
  const client = createWireClient({ baseUrl: "", recorder, fetchImpl });
  const drafts: AssistantDraft[] = [];
  const redacted: string[] = [];
  const run = (question: string, extra: { history?: { role: "user" | "assistant"; content: string }[]; signal?: AbortSignal } = {}) =>
    runChatTurn(
      { question, documentIds: ["0b8f3c2e-9d61-4f07-8a55-3e2f6b1d9c40"], history: extra.history ?? [], ...(extra.signal ? { signal: extra.signal } : {}) },
      { scrub, loadLookup: async () => VAULT, client },
      { onQueryRedacted: (o) => redacted.push(o.redactedText), onDraft: (d) => drafts.push(d) },
    );
  return { run, fetchImpl, exchanges, drafts, redacted };
}

function sseResponse(chunks: readonly string[], opts: { failAfter?: number } = {}): Response {
  return new Response(streamBody(chunks, opts), { headers: { "Content-Type": "text/event-stream" } });
}

describe("runChatTurn", () => {
  it("sends only the tokenised question and re-hydrates the streamed answer", async () => {
    const h = harness(() => sseResponse(networkChunks(HAPPY_STREAM, 7)));
    const final = await h.run("When does Daniel Reyes start apixaban? Call (617) 555-0142?");

    const body = String(h.fetchImpl.mock.calls[0]?.[1]?.body);
    expect(h.fetchImpl.mock.calls[0]?.[0]).toBe(CHAT_STREAM_PATH);
    expect(JSON.parse(body)).toEqual({
      query: "When does [PER_89A1] start apixaban? Call [PHONE_4B21]?",
      documentIds: ["0b8f3c2e-9d61-4f07-8a55-3e2f6b1d9c40"],
    });
    expect(body).not.toContain("Daniel");
    expect(detectRawPiiLeakage(body)).toEqual([]);
    expect(h.redacted).toEqual(["When does [PER_89A1] start apixaban? Call [PHONE_4B21]?"]);

    expect(final.phase).toBe("done");
    expect(final.wireText).toBe(DELTAS.join(""));
    expect(toRenderSegments(final.segments)).toEqual([
      { type: "entity", token: "[PER_89A1]", originalValue: "Daniel Reyes" },
      { type: "text", content: " starts apixaban " },
      { type: "citation", marker: "[CIT-01]" },
      { type: "text", content: ". Call " },
      { type: "entity", token: "[PHONE_4B21]", originalValue: "(617) 555-0142" },
      { type: "text", content: " or " },
      // Invented by the model: stays a token.
      { type: "entity", token: "[PER_FFFF]", originalValue: undefined },
      { type: "text", content: " " },
      { type: "citation", marker: "[CIT-01]" },
      { type: "text", content: "." },
    ]);
    expect(final.retrieval?.citations[0]?.citationMarker).toBe("[CIT-01]");
    expect(final.grounding?.unknownTokens).toEqual(["[PER_FFFF]"]);
    expect(final.done?.latency.totalMs).toBe(52);

    // Citations are visible before any answer text arrives.
    const firstWithRetrieval = h.drafts.findIndex((d) => d.retrieval !== null);
    const firstWithText = h.drafts.findIndex((d) => d.segments.length > 0);
    expect(firstWithRetrieval).toBeGreaterThanOrEqual(0);
    expect(firstWithRetrieval).toBeLessThan(firstWithText);
  });

  it("produces the same segments however the network chunks the stream", async () => {
    const results: string[] = [];
    for (const size of [1, 3, 64, HAPPY_STREAM.length]) {
      const h = harness(() => sseResponse(networkChunks(HAPPY_STREAM, size)));
      results.push(JSON.stringify(toRenderSegments((await h.run("Daniel Reyes?")).segments)));
    }
    expect(new Set(results).size).toBe(1);
  });

  it("blocks locally when the scrubber misses a structured identifier, without calling fetch", async () => {
    const leakyScrub = async (text: string): Promise<RedactionOutcome> => ({ redactedText: text, entities: [] });
    const h = harness(() => sseResponse([HAPPY_STREAM]), leakyScrub);
    const final = await h.run("Is SSN 512-48-3307 on file?");

    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(final.phase).toBe("failed");
    expect(final.error).toContain("Blocked in the browser");
    expect(final.error).toContain("SSN");
    expect(final.error).not.toContain("512-48-3307");
    expect(h.exchanges[0]).toMatchObject({ status: "blocked", requestBody: null });
  });

  it("reports a server-side 422 without echoing the payload", async () => {
    const h = harness(
      () => new Response(JSON.stringify({ error: "ZERO_TRUST_VIOLATION", traceId: "t-422" }), { status: 422, headers: { "Content-Type": "application/json" } }),
    );
    const final = await h.run("Daniel Reyes?");
    expect(final.phase).toBe("failed");
    expect(final.error).toBe("The API rejected the request as containing raw PII (HTTP 422). Trace t-422.");
  });

  it("keeps the partial answer and flags a mid-stream error event", async () => {
    const h = harness(() =>
      sseResponse([sse("retrieval", RETRIEVAL), sse("delta", { text: "[PER_89A1] is " }), sse("error", { error: "STREAM_FAILED", traceId: "t-2" })]),
    );
    const final = await h.run("Daniel Reyes?");
    expect(final.phase).toBe("failed");
    expect(final.error).toContain("partial answer");
    expect(toRenderSegments(final.segments)[0]).toEqual({ type: "entity", token: "[PER_89A1]", originalValue: "Daniel Reyes" });
  });

  it("flushes a half-received token as text when the connection drops", async () => {
    const h = harness(() => sseResponse([sse("retrieval", RETRIEVAL), sse("delta", { text: "Seen by [PER_8" })], { failAfter: 2 }));
    const final = await h.run("Daniel Reyes?");
    expect(final.phase).toBe("failed");
    expect(final.error).toBe("Cannot reach the API. Is apps/api running?");
    expect(toRenderSegments(final.segments)).toEqual([{ type: "text", content: "Seen by [PER_8" }]);
  });

  it("rejects a malformed event instead of rendering it", async () => {
    const h = harness(() => sseResponse([sse("retrieval", { citations: "nope" })]));
    const final = await h.run("Daniel Reyes?");
    expect(final.phase).toBe("failed");
    expect(final.error).toContain('Malformed "retrieval" event');
  });

  it("ends as aborted when the user stops before sending", async () => {
    const controller = new AbortController();
    controller.abort();
    const h = harness(() => sseResponse([HAPPY_STREAM]));
    const final = await h.run("Daniel Reyes?", { signal: controller.signal });
    expect(final.phase).toBe("aborted");
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it("sends tokenised history and drops turns that would trip the guard", async () => {
    const h = harness(() => sseResponse([HAPPY_STREAM]));
    await h.run("And Dr. Amara Okafor?", {
      history: [
        { role: "user", content: "Who treats [PER_89A1]?" },
        { role: "assistant", content: "Call 617-555-0142 [CIT-01]." },
      ],
    });
    expect(JSON.parse(String(h.fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({
      query: "And [PER_C0DE]?",
      history: [{ role: "user", content: "Who treats [PER_89A1]?" }],
    });
  });
});

describe("buildHistory", () => {
  it("keeps the most recent 20 clean turns", () => {
    const turns = Array.from({ length: 30 }, (_, i) => ({ role: "user" as const, content: `turn ${i}` }));
    const history = buildHistory(turns);
    expect(history).toHaveLength(20);
    expect(history[0]?.content).toBe("turn 10");
  });
});
