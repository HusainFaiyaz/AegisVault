import type { RedactedEntity } from "@aegis/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import type { WireExchange } from "../../lib/wire-client.js";
import { MAX_EXCHANGES, networkRecorder, useNetworkLog } from "../../stores/network-log.store.js";
import { formatConfidence, HydratedEntityPill } from "../HydratedEntityPill.js";
import { ExchangeDetail, NetworkProofPanel } from "../NetworkProofDrawer.js";
import { XRayView } from "../RedactionStudioPane.js";
import { TelemetryHeader, type TelemetryHeaderProps } from "../TelemetryHeader.js";

const DANIEL: RedactedEntity = { token: "[PER_89A1]", category: "PER", originalValue: "Daniel Reyes", confidence: 0.97 };
const SSN: RedactedEntity = { token: "[SSN_1A2B]", category: "SSN", originalValue: "512-48-3307", confidence: 1 };
const VAULT = new Map([
  [DANIEL.token, DANIEL],
  [SSN.token, SSN],
]);

function exchange(overrides: Partial<WireExchange> = {}): WireExchange {
  return {
    id: crypto.randomUUID(),
    label: "Chat stream",
    method: "POST",
    url: "/api/v1/chat/stream",
    startedAt: 0,
    durationMs: 40,
    requestBody: '{"query":"Plan for [PER_89A1]?"}',
    requestBytes: 31,
    verdict: { clean: true, categories: [] },
    status: "complete",
    httpStatus: 200,
    responseBody: null,
    chunks: [],
    error: null,
    ...overrides,
  };
}

describe("HydratedEntityPill", () => {
  it("shows the decrypted value, with the wire token and confidence in its popover", () => {
    const html = renderToStaticMarkup(<HydratedEntityPill token={DANIEL.token} originalValue={DANIEL.originalValue} entity={DANIEL} />);
    expect(html).toContain('data-resolved="true"');
    expect(html).toMatch(/<button[^>]*>Daniel Reyes<\/button>/);
    expect(html).toContain("[PER_89A1]");
    expect(html).toContain("Person");
    expect(html).toContain("97.0% · NER");
    expect(html).toContain("AES-GCM-256");
    expect(html).toMatch(/aria-describedby="([^"]+)"[\s\S]*id="\1"/);
  });

  it("labels regex detections as exact matches and never rounds an NER score up to 100%", () => {
    expect(renderToStaticMarkup(<HydratedEntityPill token={SSN.token} originalValue={SSN.originalValue} entity={SSN} />)).toContain(
      "Exact match · regex",
    );
    expect(formatConfidence(0.9996, "LOC")).toBe("99.9% · NER");
    expect(formatConfidence(1, "PER")).toBe("100.0% · NER");
  });

  it("keeps an unresolvable token visibly a token", () => {
    const html = renderToStaticMarkup(<HydratedEntityPill token="[PER_FFFF]" originalValue={undefined} />);
    expect(html).toContain('data-resolved="false"');
    expect(html).toMatch(/<button[^>]*>\[PER_FFFF\]<\/button>/);
    expect(html).toContain("Not in this browser&#x27;s vault");
  });
});

describe("XRayView", () => {
  const redacted = "Patient [PER_89A1], SSN [SSN_1A2B], seen by [PER_0000].";

  it("raw mode re-hydrates every vault token in place", () => {
    const html = renderToStaticMarkup(<XRayView redactedText={redacted} vault={VAULT} mode="raw" />);
    expect(html).toContain("Daniel Reyes");
    expect(html).toContain("512-48-3307");
    expect(html).toMatch(/<button[^>]*>\[PER_0000\]<\/button>/);
  });

  it("wire mode shows exactly the sanitised text and no vault value", () => {
    const html = renderToStaticMarkup(<XRayView redactedText={redacted} vault={VAULT} mode="wire" />);
    expect(html).not.toContain("Daniel Reyes");
    expect(html).not.toContain("512-48-3307");
    expect(html.replace(/<[^>]+>/g, "")).toBe(redacted);
  });
});

describe("TelemetryHeader", () => {
  const base: TelemetryHeaderProps = {
    status: "ready",
    device: "webgpu",
    progress: null,
    error: null,
    vaultEntityCount: 7,
    vaultLoaded: true,
    lastScrub: { ms: 184.4, kind: "text", entityCount: 7 },
    sessionId: "5f1c2a90-0000-4000-8000-000000000000",
    purging: false,
    onPurge: () => undefined,
  };

  it("reports WebGPU precision, a sealed vault, scrub latency and the purge control", () => {
    const html = renderToStaticMarkup(<TelemetryHeader {...base} />);
    expect(html).toContain("WebGPU edge inference");
    expect(html).toContain("NER FP32 · Whisper FP32/Q4");
    expect(html).toContain("Sealed · 7 entities");
    expect(html).toContain("184 ms · 7 found");
    expect(html).toContain("Purge Vault");
    expect(html).toContain("5f1c2a90");
  });

  it("reports the WASM fallback, an empty vault and model download progress", () => {
    expect(renderToStaticMarkup(<TelemetryHeader {...base} device="wasm" vaultEntityCount={0} />)).toMatch(/WASM[\s\S]*NER Q8 · Whisper Q8[\s\S]*Empty/);
    const loading = renderToStaticMarkup(
      <TelemetryHeader {...base} status="loading" device={null} progress={{ model: "m", file: "onnx/model_quantized.onnx", progress: 41.6 }} />,
    );
    expect(loading).toContain("model_quantized.onnx 42%");
  });
});

describe("Network proof", () => {
  beforeEach(() => {
    useNetworkLog.setState({ exchanges: [], selectedId: null });
  });

  it("shows a blocked request without its payload", () => {
    const html = renderToStaticMarkup(
      <ExchangeDetail exchange={exchange({ status: "blocked", requestBody: null, verdict: { clean: false, categories: ["SSN"] }, httpStatus: null })} />,
    );
    expect(html).toContain("Not sent. The browser refused this request before fetch()");
    expect(html).toContain("raw SSN detected");
  });

  it("shows the exact outbound body and each raw inbound SSE chunk, scanning both directions", () => {
    const chunks = [
      { at: 3.2, text: 'event: delta\ndata: {"text":"[PER_8' },
      { at: 9.7, text: '9A1] is stable"}\n\n' },
    ];
    const html = renderToStaticMarkup(<ExchangeDetail exchange={exchange({ chunks })} />);
    expect(html).toContain("Plan for [PER_89A1]?");
    expect(html).toContain("0 raw PII patterns in the request");
    expect(html).toContain("2 chunks");
    expect(html).toContain("+3ms");
    expect(html).toContain("+10ms");
    expect(html).toContain("[PER_8");
    expect(html).toContain("0 raw PII patterns in the response");
  });

  it("does not mistake float relevance scores in the stream for card numbers", () => {
    const html = renderToStaticMarkup(
      <ExchangeDetail exchange={exchange({ chunks: [{ at: 1, text: 'event: retrieval\ndata: {"score":0.0163934426229508}\n\n' }] })} />,
    );
    expect(html).toContain("0 raw PII patterns in the response");
  });

  it("flags raw PII arriving from the server", () => {
    const html = renderToStaticMarkup(
      <ExchangeDetail exchange={exchange({ chunks: [{ at: 1, text: 'data: {"text":"call 617-555-0142"}\n\n' }] })} />,
    );
    expect(html).toContain("raw PHONE detected");
  });

  it("summarises sent and blocked requests and lists every exchange when open", () => {
    const sent = exchange();
    const blocked = exchange({ status: "blocked", requestBody: null, verdict: { clean: false, categories: ["EMAIL"] }, label: "Index document" });
    const noop = (): void => undefined;
    const html = renderToStaticMarkup(
      <NetworkProofPanel exchanges={[sent, blocked]} selectedId={sent.id} open onToggle={noop} onSelect={noop} onClear={noop} />,
    );
    expect(html).toContain("1 sent · 1 blocked in browser · ");
    expect(html).toContain("0 raw PII on the wire");
    expect(html).toContain("Index document");
    expect(html).toContain("Plan for [PER_89A1]?");

    const closed = renderToStaticMarkup(<NetworkProofPanel exchanges={[]} selectedId={null} open={false} onToggle={noop} onSelect={noop} onClear={noop} />);
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).not.toContain("Outbound payload");
  });

  it("recorder appends chunks, follows the newest exchange and caps the log", () => {
    const first = exchange({ status: "streaming", chunks: [] });
    networkRecorder.begin(first);
    networkRecorder.appendChunk(first.id, { at: 1, text: "a" });
    networkRecorder.appendChunk(first.id, { at: 2, text: "b" });
    networkRecorder.update(first.id, { status: "complete" });
    expect(useNetworkLog.getState().exchanges[0]).toMatchObject({ status: "complete", chunks: [{ text: "a" }, { text: "b" }] });
    expect(useNetworkLog.getState().selectedId).toBe(first.id);

    const second = exchange();
    networkRecorder.begin(second);
    expect(useNetworkLog.getState().selectedId).toBe(second.id);

    // A pinned older selection is kept.
    useNetworkLog.getState().select(first.id);
    networkRecorder.begin(exchange());
    expect(useNetworkLog.getState().selectedId).toBe(first.id);

    for (let i = 0; i < MAX_EXCHANGES + 5; i += 1) networkRecorder.begin(exchange());
    expect(useNetworkLog.getState().exchanges).toHaveLength(MAX_EXCHANGES);
  });
});
