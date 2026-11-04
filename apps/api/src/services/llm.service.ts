import { createAnthropic } from "@ai-sdk/anthropic";
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from "@ai-sdk/provider";

/**
 * Language model selection for the chat stream.
 *
 * With a real `AI_PROVIDER_API_KEY` the Vercel AI SDK Anthropic provider is
 * used. With an empty key or `"mock"`, a deterministic offline model answers
 * from the sources in the prompt, so local dev and CI stream end to end
 * without network access (mirrors the `VOYAGE_API_KEY="mock"` fallback).
 */

export const DEFAULT_CHAT_MODEL = "claude-opus-5-5";
export const MOCK_MODEL_ID = "aegis-mock-grounded";

export type LlmMode = "live" | "mock";

export interface ChatModel {
  mode: LlmMode;
  modelId: string;
  model: LanguageModelV4;
}

export interface ChatModelConfig {
  apiKey: string;
  modelId?: string;
  /** Delay between mock deltas, so the mock streams like a real model. */
  mockChunkDelayMs?: number;
}

export function isMockKey(apiKey: string): boolean {
  const trimmed = apiKey.trim();
  return trimmed === "" || trimmed === "mock";
}

export function createChatModel(config: ChatModelConfig): ChatModel {
  if (isMockKey(config.apiKey)) {
    return {
      mode: "mock",
      modelId: MOCK_MODEL_ID,
      model: createMockGroundedModel({ chunkDelayMs: config.mockChunkDelayMs ?? 15 }),
    };
  }
  const modelId = config.modelId ?? DEFAULT_CHAT_MODEL;
  const anthropic = createAnthropic({ apiKey: config.apiKey });
  return { mode: "live", modelId, model: anthropic(modelId) };
}

// ---------------------------------------------------------------------------
// Deterministic mock
// ---------------------------------------------------------------------------

const SOURCE_PATTERN = /<source marker="(\[CIT-\d{2}\])"(?:\s+[a-z]+="[^"]*")*>\n([\s\S]*?)\n<\/source>/g;

/** Uneven delta sizes so placeholder tokens get split across chunks. */
const DELTA_SIZES = [3, 5, 2, 7, 4, 6];

export const MOCK_NO_SOURCES_ANSWER =
  "I couldn't find anything about that in the indexed documents, so I can't answer it from your files.";

function unescapeSourceText(text: string): string {
  return text.replace(/&lt;/g, "<").replace(/&amp;/g, "&");
}

function lastUserText(options: LanguageModelV4CallOptions): string {
  for (let i = options.prompt.length - 1; i >= 0; i -= 1) {
    const message = options.prompt[i];
    if (message?.role === "user") {
      return message.content
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("");
    }
  }
  return "";
}

function firstSentence(content: string): string {
  const body = content
    .split("\n")
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .filter((line) => line.length > 0)
    .join(" ");
  const match = /^.*?[.!?](?=\s|$)/.exec(body);
  const sentence = (match ? match[0] : body.slice(0, 200)).trim();
  return sentence.replace(/[.!?]+$/, "");
}

/** Builds the mock's answer: the opening sentence of up to three sources, each cited. */
export function composeMockAnswer(promptText: string): string {
  const sources = [...promptText.matchAll(SOURCE_PATTERN)].slice(0, 3);
  if (sources.length === 0) {
    return MOCK_NO_SOURCES_ANSWER;
  }
  const lines = sources.map(([, marker, body]) => `${firstSentence(unescapeSourceText(body ?? ""))} ${marker}.`);
  return `Here is what your documents say. ${lines.join(" ")}`;
}

export function splitIntoDeltas(text: string): string[] {
  const deltas: string[] = [];
  let offset = 0;
  for (let i = 0; offset < text.length; i += 1) {
    const size = DELTA_SIZES[i % DELTA_SIZES.length] ?? 4;
    deltas.push(text.slice(offset, offset + size));
    offset += size;
  }
  return deltas;
}

function approximateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function usageFor(promptText: string, answer: string): LanguageModelV4Usage {
  const input = approximateTokens(promptText);
  const output = approximateTokens(answer);
  return {
    inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: output, text: output, reasoning: 0 },
  };
}

function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface MockGroundedModelOptions {
  chunkDelayMs?: number;
}

export function createMockGroundedModel({ chunkDelayMs = 0 }: MockGroundedModelOptions = {}): LanguageModelV4 {
  return {
    specificationVersion: "v4",
    provider: "aegis-mock",
    modelId: MOCK_MODEL_ID,
    supportedUrls: {},

    async doGenerate(options) {
      const promptText = lastUserText(options);
      const answer = composeMockAnswer(promptText);
      return {
        content: [{ type: "text", text: answer }],
        finishReason: { unified: "stop", raw: "end_turn" },
        usage: usageFor(promptText, answer),
        warnings: [],
      };
    },

    async doStream(options) {
      const promptText = lastUserText(options);
      const answer = composeMockAnswer(promptText);
      const deltas = splitIntoDeltas(answer);
      const signal = options.abortSignal;

      const stream = new ReadableStream<LanguageModelV4StreamPart>({
        async start(controller) {
          try {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "response-metadata", id: "mock-response", modelId: MOCK_MODEL_ID });
            controller.enqueue({ type: "text-start", id: "t0" });
            for (const delta of deltas) {
              await wait(chunkDelayMs, signal);
              controller.enqueue({ type: "text-delta", id: "t0", delta });
            }
            controller.enqueue({ type: "text-end", id: "t0" });
            controller.enqueue({
              type: "finish",
              finishReason: { unified: "stop", raw: "end_turn" },
              usage: usageFor(promptText, answer),
            });
            controller.close();
          } catch (error) {
            controller.error(error);
          }
        },
      });
      return { stream };
    },
  };
}
