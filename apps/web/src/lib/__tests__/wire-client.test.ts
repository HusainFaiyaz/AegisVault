import { describe, expect, it, vi } from "vitest";
import { ApiError, createWireClient, inspectEgress, inspectInbound, ZeroTrustEgressError, type WireExchange, type WireRecorder } from "../wire-client.js";

function memoryRecorder(): WireRecorder & { exchanges: WireExchange[] } {
  const exchanges: WireExchange[] = [];
  const find = (id: string): WireExchange => {
    const exchange = exchanges.find((candidate) => candidate.id === id);
    if (exchange === undefined) throw new Error(`no exchange ${id}`);
    return exchange;
  };
  return {
    exchanges,
    begin: (exchange) => void exchanges.push(structuredClone(exchange)),
    update: (id, patch) => void Object.assign(find(id), patch),
    appendChunk: (id, chunk) => void find(id).chunks.push(chunk),
  };
}

function sseResponse(chunks: readonly string[], status = 200): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { "Content-Type": "text/event-stream; charset=utf-8" } });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function setup(fetchImpl: typeof fetch) {
  const recorder = memoryRecorder();
  let id = 0;
  const client = createWireClient({ baseUrl: "http://api.test", recorder, fetchImpl, newId: () => `x${++id}` });
  return { client, recorder };
}

describe("inspectEgress", () => {
  it("passes tokens and UUIDs, flags raw identifiers by category only", () => {
    expect(inspectEgress('{"q":"[PER_89A1] [SSN_1A2B]","id":"0b8f3c2e-9d61-4f07-8a55-3e2f6b1d9c40"}')).toEqual({ clean: true, categories: [] });
    const verdict = inspectEgress("call (617) 555-0142", "ssn 512-48-3307");
    expect(verdict.clean).toBe(false);
    expect([...verdict.categories].sort()).toEqual(["PHONE", "SSN"]);
  });
});

describe("inspectInbound", () => {
  const score = 0.0163934426229508; // 16 fractional digits: card-shaped as raw text
  it("ignores float scores in JSON and SSE metadata but still finds PII in strings", () => {
    expect(inspectEgress(JSON.stringify({ score })).clean).toBe(false);
    expect(inspectInbound(JSON.stringify({ score, text: "[PER_89A1]" }), "json")).toEqual({ clean: true, categories: [] });
    const stream = `event: retrieval\ndata: ${JSON.stringify({ score })}\n\nevent: delta\ndata: {"text":"call 617-555-0142"}\n\n`;
    expect(inspectInbound(stream, "event-stream").categories).toEqual(["PHONE"]);
  });

  it("falls back to scanning non-JSON text verbatim", () => {
    expect(inspectInbound("<html>ssn 512-48-3307</html>", "json").categories).toEqual(["SSN"]);
    expect(inspectInbound("data: not json 512-48-3307\n\n", "event-stream").categories).toEqual(["SSN"]);
  });
});

describe("createWireClient", () => {
  it("refuses to send a payload with raw PII and keeps no copy of it", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { client, recorder } = setup(fetchImpl);
    const attempt = client.postJson("/api/v1/chat/stream", { query: "Is 512-48-3307 on file?" }, "Chat");
    await expect(attempt).rejects.toBeInstanceOf(ZeroTrustEgressError);
    await expect(attempt).rejects.toMatchObject({ categories: ["SSN"] });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(recorder.exchanges[0]).toMatchObject({ status: "blocked", requestBody: null, verdict: { clean: false, categories: ["SSN"] } });
    expect(JSON.stringify(recorder.exchanges)).not.toContain("512-48-3307");
  });

  it("refuses raw PII in the URL too", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { client } = setup(fetchImpl);
    await expect(client.getJson("/api/v1/documents/jobs/jane@example.com", "Status")).rejects.toBeInstanceOf(ZeroTrustEgressError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends the exact serialised body without credentials or referrer, and records the response", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ jobId: "j1" }, 202));
    const { client, recorder } = setup(fetchImpl);
    const payload = { sanitizedContent: "Patient [PER_89A1]" };
    await expect(client.postJson("/api/v1/documents", payload, "Index")).resolves.toEqual({ status: 202, body: { jobId: "j1" } });

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("http://api.test/api/v1/documents");
    expect(init).toMatchObject({ method: "POST", credentials: "omit", referrerPolicy: "no-referrer", body: JSON.stringify(payload) });
    expect(recorder.exchanges[0]).toMatchObject({
      status: "complete",
      httpStatus: 202,
      requestBody: JSON.stringify(payload),
      requestBytes: JSON.stringify(payload).length,
      responseBody: '{"jobId":"j1"}',
    });
  });

  it("maps JSON error responses to ApiError with code and trace id", async () => {
    const { client, recorder } = setup(async () => jsonResponse({ error: "ZERO_TRUST_VIOLATION", traceId: "t-9" }, 422));
    await expect(client.postJson("/x", {}, "X")).rejects.toMatchObject({ status: 422, code: "ZERO_TRUST_VIOLATION", traceId: "t-9" });
    expect(recorder.exchanges[0]).toMatchObject({ status: "failed", error: "ZERO_TRUST_VIOLATION" });
  });

  it("records an unreachable API as a failed exchange", async () => {
    const { client, recorder } = setup(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(client.getJson("/api/v1/health", "Health")).rejects.toBeInstanceOf(TypeError);
    expect(recorder.exchanges[0]).toMatchObject({ status: "failed", error: "Network error: API unreachable" });
  });

  it("streams SSE, recording every raw chunk in order and dispatching parsed events", async () => {
    const chunks = ['event: delta\ndata: {"text":"[PE', 'R_89A1]"}\n\nevent: do', 'ne\ndata: {}\n\n'];
    const { client, recorder } = setup(async () => sseResponse(chunks));
    const events: string[] = [];
    await client.postEventStream("/api/v1/chat/stream", { query: "q" }, { label: "Chat", onMessage: (m) => events.push(`${m.event}:${m.data}`) });

    expect(events).toEqual(['delta:{"text":"[PER_89A1]"}', "done:{}"]);
    expect(recorder.exchanges[0]?.chunks.map((chunk) => chunk.text)).toEqual(chunks);
    expect(recorder.exchanges[0]?.status).toBe("complete");
  });

  it("treats a pre-stream JSON failure on the stream endpoint as an ApiError", async () => {
    const { client } = setup(async () => jsonResponse({ error: "RATE_LIMITED", traceId: "t-1" }, 429));
    await expect(
      client.postEventStream("/api/v1/chat/stream", { query: "q" }, { label: "Chat", onMessage: () => undefined }),
    ).rejects.toBeInstanceOf(ApiError);
  });
});
