/**
 * Microphone dictation for the Whisper worker. Audio is recorded with
 * `MediaRecorder`, then decoded and resampled to 16 kHz mono in the browser
 * (Whisper's input format). The samples go straight to the scrubber worker;
 * neither the audio nor its transcript is ever uploaded.
 */

export const WHISPER_SAMPLE_RATE = 16_000;
/** Whisper-tiny handles 30 s windows; dictation is capped there. */
export const MAX_DICTATION_SECONDS = 30;

export interface DictationSession {
  /** Stops recording and resolves with 16 kHz mono PCM. */
  stop(): Promise<Float32Array>;
  /** Stops recording and discards the audio. */
  cancel(): void;
}

export class MicrophoneUnavailableError extends Error {
  override name = "MicrophoneUnavailableError";
}

/** Averages all channels into one. */
export function downmixToMono(channels: readonly Float32Array[]): Float32Array {
  const first = channels[0];
  if (first === undefined) return new Float32Array(0);
  if (channels.length === 1) return first;
  const mono = new Float32Array(first.length);
  for (const channel of channels) {
    for (let i = 0; i < mono.length; i += 1) mono[i] = (mono[i] ?? 0) + (channel[i] ?? 0);
  }
  for (let i = 0; i < mono.length; i += 1) mono[i] = (mono[i] ?? 0) / channels.length;
  return mono;
}

async function decodeTo16kMono(blob: Blob): Promise<Float32Array> {
  // An AudioContext created at 16 kHz resamples during decodeAudioData.
  const context = new AudioContext({ sampleRate: WHISPER_SAMPLE_RATE });
  try {
    const buffer = await context.decodeAudioData(await blob.arrayBuffer());
    const channels: Float32Array[] = [];
    for (let c = 0; c < buffer.numberOfChannels; c += 1) channels.push(buffer.getChannelData(c));
    return downmixToMono(channels).slice(0, WHISPER_SAMPLE_RATE * MAX_DICTATION_SECONDS);
  } finally {
    void context.close();
  }
}

export async function startDictation(): Promise<DictationSession> {
  if (typeof navigator.mediaDevices?.getUserMedia !== "function") {
    throw new MicrophoneUnavailableError("This browser does not expose a microphone API");
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
  } catch {
    throw new MicrophoneUnavailableError("Microphone permission was denied");
  }

  const recorder = new MediaRecorder(stream);
  const parts: Blob[] = [];
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) parts.push(event.data);
  });
  const stopped = new Promise<void>((resolve) => {
    recorder.addEventListener("stop", () => resolve(), { once: true });
  });
  const release = (): void => stream.getTracks().forEach((track) => track.stop());
  const autoStop = window.setTimeout(() => {
    if (recorder.state === "recording") recorder.stop();
  }, MAX_DICTATION_SECONDS * 1000);
  recorder.start();

  return {
    async stop() {
      window.clearTimeout(autoStop);
      if (recorder.state === "recording") recorder.stop();
      await stopped;
      release();
      return decodeTo16kMono(new Blob(parts, { type: recorder.mimeType }));
    },
    cancel() {
      window.clearTimeout(autoStop);
      if (recorder.state === "recording") recorder.stop();
      release();
      parts.length = 0;
    },
  };
}
