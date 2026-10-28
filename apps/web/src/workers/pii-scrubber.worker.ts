import { env, pipeline } from "@huggingface/transformers";
import {
  aggregateNerTokens,
  chunkForNer,
  scrubWithSpans,
  type DetectedSpan,
  type NerTokenPrediction,
  type ScrubResult,
} from "./scrubber-span-merger.js";

/**
 * Browser-edge PII scrubber. Runs Transformers.js entirely inside this Web
 * Worker: `Xenova/bert-base-NER` for PER/ORG/LOC and
 * `onnx-community/whisper-tiny.en` for voice dictation. Raw text and audio
 * never leave the browser; the main thread only receives redacted text plus
 * the token → original-value entities it writes to the encrypted vault.
 */

const NER_MODEL_ID = "Xenova/bert-base-NER";
const ASR_MODEL_ID = "onnx-community/whisper-tiny.en";

export type InferenceDevice = "webgpu" | "wasm";

export type ScrubberRequest =
  | { type: "init"; sessionKey: CryptoKey }
  | { type: "scrub"; id: number; text: string }
  /** 16 kHz mono PCM samples. */
  | { type: "transcribe"; id: number; audio: Float32Array };

export type ScrubberResponse =
  | { type: "ready"; device: InferenceDevice }
  | { type: "progress"; model: string; file: string; progress: number }
  | { type: "scrubbed"; id: number; result: ScrubResult }
  | { type: "transcribed"; id: number; result: ScrubResult }
  | { type: "error"; id: number | null; message: string };

interface NerPipeline {
  (
    text: string,
    options: { ignore_labels: string[] },
  ): Promise<NerTokenPrediction[] | NerTokenPrediction[][]>;
}

interface AsrPipeline {
  (audio: Float32Array): Promise<{ text: string } | Array<{ text: string }>>;
}

interface ProgressInfo {
  status: string;
  file?: string;
  progress?: number;
}

// Models are fetched from the Hugging Face Hub and cached by the browser;
// there is no local model directory to probe.
env.allowLocalModels = false;

/** The subset of `DedicatedWorkerGlobalScope` this worker uses. */
interface WorkerScope {
  postMessage(message: ScrubberResponse): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<ScrubberRequest>) => void,
  ): void;
}

/** The subset of the WebGPU `navigator.gpu` API needed to probe support. */
interface GpuProbe {
  requestAdapter(): Promise<unknown>;
}

const scope = self as unknown as WorkerScope;

let sessionKey: CryptoKey | null = null;
let device: InferenceDevice = "wasm";
let nerPipeline: Promise<NerPipeline> | null = null;
let asrPipeline: Promise<AsrPipeline> | null = null;

function post(message: ScrubberResponse): void {
  scope.postMessage(message);
}

function reportProgress(model: string) {
  return (info: ProgressInfo): void => {
    if (info.status === "progress" && info.file !== undefined) {
      post({
        type: "progress",
        model,
        file: info.file,
        progress: info.progress ?? 0,
      });
    }
  };
}

async function detectDevice(): Promise<InferenceDevice> {
  const gpu = (navigator as Navigator & { gpu?: GpuProbe }).gpu;
  if (gpu === undefined) return "wasm";
  try {
    return (await gpu.requestAdapter()) !== null ? "webgpu" : "wasm";
  } catch {
    return "wasm";
  }
}

/**
 * Loads a pipeline on WebGPU when available, falling back to WASM if the
 * adapter exists but the model fails to initialise on it (driver quirks,
 * unsupported ops, out-of-memory).
 */
async function loadWithFallback<T>(
  load: (target: InferenceDevice) => Promise<T>,
): Promise<T> {
  if (device === "webgpu") {
    try {
      return await load("webgpu");
    } catch {
      device = "wasm";
    }
  }
  return load("wasm");
}

function getNerPipeline(): Promise<NerPipeline> {
  nerPipeline ??= loadWithFallback(
    async (target) =>
      (await pipeline("token-classification", NER_MODEL_ID, {
        device: target,
        dtype: target === "webgpu" ? "fp32" : "q8",
        progress_callback: reportProgress(NER_MODEL_ID),
      })) as unknown as NerPipeline,
  );
  return nerPipeline;
}

function getAsrPipeline(): Promise<AsrPipeline> {
  asrPipeline ??= loadWithFallback(
    async (target) =>
      (await pipeline("automatic-speech-recognition", ASR_MODEL_ID, {
        device: target,
        dtype:
          target === "webgpu"
            ? { encoder_model: "fp32", decoder_model_merged: "q4" }
            : "q8",
        progress_callback: reportProgress(ASR_MODEL_ID),
      })) as unknown as AsrPipeline,
  );
  return asrPipeline;
}

async function detectNerSpans(text: string): Promise<DetectedSpan[]> {
  const ner = await getNerPipeline();
  const spans: DetectedSpan[] = [];
  for (const chunk of chunkForNer(text)) {
    if (chunk.text.trim().length === 0) continue;
    const output = await ner(chunk.text, { ignore_labels: [] });
    const tokens = output.flat();
    for (const span of aggregateNerTokens(chunk.text, tokens)) {
      spans.push({
        ...span,
        start: span.start + chunk.offset,
        end: span.end + chunk.offset,
      });
    }
  }
  return spans;
}

async function scrub(text: string): Promise<ScrubResult> {
  if (sessionKey === null) {
    throw new Error("Scrubber not initialised with a session key");
  }
  return scrubWithSpans(text, await detectNerSpans(text), sessionKey);
}

async function transcribe(audio: Float32Array): Promise<string> {
  const asr = await getAsrPipeline();
  const output = await asr(audio);
  return (Array.isArray(output) ? output : [output])
    .map((segment) => segment.text)
    .join(" ")
    .trim();
}

async function handle(request: ScrubberRequest): Promise<void> {
  switch (request.type) {
    case "init": {
      sessionKey = request.sessionKey;
      device = await detectDevice();
      await getNerPipeline();
      post({ type: "ready", device });
      return;
    }
    case "scrub": {
      post({ type: "scrubbed", id: request.id, result: await scrub(request.text) });
      return;
    }
    case "transcribe": {
      // The raw transcript is scrubbed here, inside the worker, so the main
      // thread never holds unredacted dictation outside the vault entities.
      const transcript = await transcribe(request.audio);
      post({
        type: "transcribed",
        id: request.id,
        result: await scrub(transcript),
      });
      return;
    }
  }
}

scope.addEventListener("message", (event: MessageEvent<ScrubberRequest>) => {
  const request = event.data;
  handle(request).catch((error: unknown) => {
    post({
      type: "error",
      id: request.type === "init" ? null : request.id,
      message: error instanceof Error ? error.message : String(error),
    });
  });
});
