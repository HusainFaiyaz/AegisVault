import { detectRawPiiLeakage, type EntityCategory } from "@aegis/shared";
import { SseParser, type SseMessage } from "./sse-parser.js";

/**
 * The only path from the browser to `apps/api`.
 *
 * Every request body (and URL) is serialised first, scanned with the same
 * guard the server enforces, and refused locally if anything raw-PII-shaped
 * is present: the request is never handed to `fetch`. Every exchange that
 * does go out is recorded byte for byte (request body, response body, each
 * raw SSE chunk as it arrived) so the Network Proof drawer shows what
 * actually crossed the wire, not a re-rendering of it.
 */

export interface WireChunk {
  /** Milliseconds since the exchange started. */
  at: number;
  text: string;
}

export type WireStatus =
  | "blocked"
  | "pending"
  | "streaming"
  | "complete"
  | "failed"
  | "aborted";

export interface EgressVerdict {
  clean: boolean;
  /** Categories only: matched values are never kept. */
  categories: EntityCategory[];
}

export interface WireExchange {
  id: string;
  label: string;
  method: "GET" | "POST";
  url: string;
  startedAt: number;
  durationMs: number | null;
  /** Exact request body sent. Null for GET, and for blocked requests (never retained). */
  requestBody: string | null;
  requestBytes: number;
  verdict: EgressVerdict;
  status: WireStatus;
  httpStatus: number | null;
  /** Raw response body for JSON exchanges. */
  responseBody: string | null;
  /** Raw decoded chunks for event-stream exchanges, in arrival order. */
  chunks: WireChunk[];
  error: string | null;
}

export interface WireRecorder {
  begin(exchange: WireExchange): void;
  update(id: string, patch: Partial<WireExchange>): void;
  appendChunk(id: string, chunk: WireChunk): void;
}

export class ZeroTrustEgressError extends Error {
  override name = "ZeroTrustEgressError";
  constructor(readonly categories: EntityCategory[]) {
    super(
      `Blocked in the browser: payload contains raw ${categories.join(", ")}`,
    );
  }
}

export class ApiError extends Error {
  override name = "ApiError";
  constructor(
    readonly status: number,
    readonly code: string,
    readonly traceId: string | null,
  ) {
    super(`${code} (HTTP ${status})`);
  }
}

export interface WireClientOptions {
  baseUrl: string;
  recorder: WireRecorder;
  fetchImpl?: typeof fetch;
  now?: () => number;
  newId?: () => string;
}

export interface EventStreamOptions {
  label: string;
  signal?: AbortSignal;
  onMessage: (message: SseMessage) => void;
}

export interface JsonResponse {
  status: number;
  body: unknown;
}

export interface WireClient {
  getJson(path: string, label: string): Promise<JsonResponse>;
  postJson(path: string, payload: unknown, label: string): Promise<JsonResponse>;
  postEventStream(path: string, payload: unknown, options: EventStreamOptions): Promise<void>;
}

/** Scans exactly what would be sent. */
export function inspectEgress(...parts: string[]): EgressVerdict {
  const categories = [
    ...new Set(parts.flatMap((part) => detectRawPiiLeakage(part).map((f) => f.category))),
  ];
  return { clean: categories.length === 0, categories };
}

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out);
  else if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      out.push(key);
      collectStrings(item, out);
    }
  }
}

function jsonStrings(text: string): string[] | null {
  try {
    const out: string[] = [];
    collectStrings(JSON.parse(text) as unknown, out);
    return out;
  } catch {
    return null;
  }
}

/**
 * Audits a response for raw PII. Unlike `inspectEgress` (which must match
 * the server's byte-level check exactly), this scans only JSON string keys
 * and values: response metadata is full of float scores whose 13-16 digit
 * fractions would otherwise read as card numbers. Text that is not JSON
 * (or not JSON events) is scanned verbatim.
 */
export function inspectInbound(text: string, kind: "json" | "event-stream"): EgressVerdict {
  if (kind === "json") return inspectEgress(...(jsonStrings(text) ?? [text]));
  const parser = new SseParser();
  const messages = [...parser.push(text), ...parser.end()];
  const parts = messages.flatMap((message) => [message.event, ...(jsonStrings(message.data) ?? [message.data])]);
  return inspectEgress(...parts);
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function readErrorCode(text: string): { code: string; traceId: string | null } {
  try {
    const body = JSON.parse(text) as unknown;
    if (typeof body === "object" && body !== null) {
      const record = body as Record<string, unknown>;
      return {
        code: typeof record.error === "string" ? record.error : "HTTP_ERROR",
        traceId: typeof record.traceId === "string" ? record.traceId : null,
      };
    }
  } catch {
    // Not JSON (proxy error page, empty body): fall through.
  }
  return { code: "HTTP_ERROR", traceId: null };
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function createWireClient(options: WireClientOptions): WireClient {
  const { baseUrl, recorder } = options;
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const now = options.now ?? (() => performance.now());
  const newId = options.newId ?? (() => crypto.randomUUID());

  /** Guards, records and (if clean) starts the request. */
  async function open(
    method: "GET" | "POST",
    path: string,
    payload: unknown,
    label: string,
    accept: string,
    signal?: AbortSignal,
  ): Promise<{ id: string; startedAt: number; response: Response }> {
    const url = `${baseUrl}${path}`;
    const body = method === "POST" ? JSON.stringify(payload) : null;
    const verdict = inspectEgress(url, body ?? "");
    const id = newId();
    const startedAt = now();

    recorder.begin({
      id,
      label,
      method,
      url,
      startedAt: Date.now(),
      durationMs: verdict.clean ? null : 0,
      requestBody: verdict.clean ? body : null,
      requestBytes: body === null ? 0 : byteLength(body),
      verdict,
      status: verdict.clean ? "pending" : "blocked",
      httpStatus: null,
      responseBody: null,
      chunks: [],
      error: verdict.clean ? null : "Blocked before fetch: raw PII in payload",
    });

    if (!verdict.clean) {
      throw new ZeroTrustEgressError(verdict.categories);
    }

    const headers: Record<string, string> = { Accept: accept };
    if (body !== null) headers["Content-Type"] = "application/json";

    try {
      const init: RequestInit = {
        method,
        headers,
        credentials: "omit",
        referrerPolicy: "no-referrer",
        cache: "no-store",
      };
      if (body !== null) init.body = body;
      if (signal !== undefined) init.signal = signal;
      const response = await fetchImpl(url, init);
      recorder.update(id, { httpStatus: response.status });
      return { id, startedAt, response };
    } catch (error) {
      recorder.update(id, {
        status: isAbort(error) ? "aborted" : "failed",
        durationMs: now() - startedAt,
        error: isAbort(error) ? "Cancelled" : "Network error: API unreachable",
      });
      throw error;
    }
  }

  async function finishJson(
    id: string,
    startedAt: number,
    response: Response,
  ): Promise<JsonResponse> {
    const text = await response.text();
    const ok = response.ok;
    const { code, traceId } = ok ? { code: "", traceId: null } : readErrorCode(text);
    recorder.update(id, {
      status: ok ? "complete" : "failed",
      responseBody: text,
      durationMs: now() - startedAt,
      error: ok ? null : code,
    });
    if (!ok) throw new ApiError(response.status, code, traceId);
    let body: unknown = null;
    try {
      body = text === "" ? null : (JSON.parse(text) as unknown);
    } catch {
      body = null;
    }
    return { status: response.status, body };
  }

  return {
    async getJson(path, label) {
      const { id, startedAt, response } = await open("GET", path, null, label, "application/json");
      return finishJson(id, startedAt, response);
    },

    async postJson(path, payload, label) {
      const { id, startedAt, response } = await open("POST", path, payload, label, "application/json");
      return finishJson(id, startedAt, response);
    },

    async postEventStream(path, payload, { label, signal, onMessage }) {
      const { id, startedAt, response } = await open(
        "POST",
        path,
        payload,
        label,
        "text/event-stream",
        signal,
      );

      const contentType = response.headers.get("content-type") ?? "";
      if (!response.ok || !contentType.includes("text/event-stream") || response.body === null) {
        // Pre-stream failures (400/422/429/500) are plain JSON.
        await finishJson(id, startedAt, response);
        throw new ApiError(response.status, "UNEXPECTED_RESPONSE", null);
      }

      recorder.update(id, { status: "streaming" });
      const parser = new SseParser();
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          recorder.appendChunk(id, { at: now() - startedAt, text: value });
          for (const message of parser.push(value)) onMessage(message);
        }
        for (const message of parser.end()) onMessage(message);
        recorder.update(id, { status: "complete", durationMs: now() - startedAt });
      } catch (error) {
        recorder.update(id, {
          status: isAbort(error) || signal?.aborted === true ? "aborted" : "failed",
          durationMs: now() - startedAt,
          error: isAbort(error) || signal?.aborted === true ? "Cancelled" : "Stream interrupted",
        });
        throw error;
      } finally {
        reader.releaseLock();
      }
    },
  };
}
