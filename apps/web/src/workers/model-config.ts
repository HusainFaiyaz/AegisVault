/**
 * Model ids and precision per inference device. Shared by the scrubber
 * worker (which loads with these settings) and the telemetry header (which
 * reports them), so the badge can never drift from what actually runs.
 *
 * This module must stay free of side effects: the main thread imports it.
 */

export type InferenceDevice = "webgpu" | "wasm";

export const NER_MODEL_ID = "Xenova/bert-base-NER";
export const ASR_MODEL_ID = "onnx-community/whisper-tiny.en";

export type ModelDtype = "fp32" | "fp16" | "q8" | "q4";

// A type alias (not an interface) so it satisfies Transformers.js's
// `Record<string, dtype>` per-file option.
export type AsrDtype = {
  encoder_model: ModelDtype;
  decoder_model_merged: ModelDtype;
};

/** NER precision as chosen on Day 4: fp32 on WebGPU, q8 on WASM. */
export function nerDtypeFor(device: InferenceDevice): ModelDtype {
  return device === "webgpu" ? "fp32" : "q8";
}

/** Whisper keeps the encoder at full precision and quantises the decoder to q4 on WebGPU. */
export function asrDtypeFor(device: InferenceDevice): AsrDtype | ModelDtype {
  return device === "webgpu"
    ? { encoder_model: "fp32", decoder_model_merged: "q4" }
    : "q8";
}

export interface PrecisionSummary {
  device: InferenceDevice;
  ner: string;
  asr: string;
}

export function describePrecision(device: InferenceDevice): PrecisionSummary {
  const asr = asrDtypeFor(device);
  return {
    device,
    ner: nerDtypeFor(device).toUpperCase(),
    asr:
      typeof asr === "string"
        ? asr.toUpperCase()
        : `${asr.encoder_model.toUpperCase()}/${asr.decoder_model_merged.toUpperCase()}`,
  };
}
