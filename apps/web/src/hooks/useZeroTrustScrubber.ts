import { useCallback, useEffect, useRef, useState } from "react";
import type { RedactedEntity } from "@aegis/shared";
import { generateSessionHmacKey } from "../lib/pseudonymizer.js";
import { storeRedactedBatch } from "../lib/vault.js";
import type {
  InferenceDevice,
  ScrubberRequest,
  ScrubberResponse,
} from "../workers/pii-scrubber.worker.js";
import type { ScrubResult } from "../workers/scrubber-span-merger.js";

export type ScrubberStatus = "loading" | "ready" | "error";

export interface ModelDownloadProgress {
  model: string;
  file: string;
  progress: number;
}

/**
 * What callers of the hook receive. Original PII values are deliberately
 * stripped: they are written to the encrypted IndexedDB vault and never
 * handed to React state, so nothing downstream can accidentally send them
 * to `apps/api`.
 */
export interface RedactionOutcome {
  redactedText: string;
  entities: Array<Omit<RedactedEntity, "originalValue">>;
}

interface PendingRequest {
  resolve: (result: ScrubResult) => void;
  reject: (error: Error) => void;
}

export interface ZeroTrustScrubber {
  status: ScrubberStatus;
  device: InferenceDevice | null;
  progress: ModelDownloadProgress | null;
  error: string | null;
  scrubText: (text: string) => Promise<RedactionOutcome>;
  /** `audio` must be 16 kHz mono PCM samples. */
  transcribeAndScrub: (audio: Float32Array) => Promise<RedactionOutcome>;
}

type WorkTask =
  | { type: "scrub"; text: string }
  | { type: "transcribe"; audio: Float32Array };

/**
 * Runs the PII scrubber Web Worker for one redaction session. A fresh
 * non-extractable HMAC key is generated per session and handed to the
 * worker (CryptoKey objects are structured-cloneable without exposing key
 * material). Every scrub result's entities are encrypted into the local
 * vault before the redacted text is returned to the caller.
 */
export function useZeroTrustScrubber(sessionId: string): ZeroTrustScrubber {
  const [status, setStatus] = useState<ScrubberStatus>("loading");
  const [device, setDevice] = useState<InferenceDevice | null>(null);
  const [progress, setProgress] = useState<ModelDownloadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  const workerRef = useRef<Worker | null>(null);
  const pendingRef = useRef(new Map<number, PendingRequest>());
  const nextIdRef = useRef(1);

  useEffect(() => {
    const pending = pendingRef.current;
    const worker = new Worker(
      new URL("../workers/pii-scrubber.worker.ts", import.meta.url),
      { type: "module" },
    );
    workerRef.current = worker;
    let disposed = false;

    setStatus("loading");
    setDevice(null);
    setProgress(null);
    setError(null);

    const failAll = (message: string): void => {
      for (const request of pending.values()) {
        request.reject(new Error(message));
      }
      pending.clear();
    };

    worker.addEventListener(
      "message",
      (event: MessageEvent<ScrubberResponse>) => {
        const message = event.data;
        switch (message.type) {
          case "ready":
            setDevice(message.device);
            setProgress(null);
            setStatus("ready");
            return;
          case "progress":
            setProgress({
              model: message.model,
              file: message.file,
              progress: message.progress,
            });
            return;
          case "scrubbed":
          case "transcribed": {
            const request = pending.get(message.id);
            pending.delete(message.id);
            request?.resolve(message.result);
            return;
          }
          case "error": {
            if (message.id === null) {
              setError(message.message);
              setStatus("error");
              failAll(message.message);
              return;
            }
            const request = pending.get(message.id);
            pending.delete(message.id);
            request?.reject(new Error(message.message));
            return;
          }
        }
      },
    );

    worker.addEventListener("error", (event: ErrorEvent) => {
      setError(event.message);
      setStatus("error");
      failAll(event.message);
    });

    void generateSessionHmacKey().then((sessionKey) => {
      if (disposed) return;
      const init: ScrubberRequest = { type: "init", sessionKey };
      worker.postMessage(init);
    });

    return () => {
      disposed = true;
      worker.terminate();
      workerRef.current = null;
      failAll("Scrubber session closed");
    };
  }, [sessionId]);

  const run = useCallback(
    async (task: WorkTask): Promise<RedactionOutcome> => {
      const worker = workerRef.current;
      if (worker === null) {
        throw new Error("Scrubber worker is not running");
      }

      const id = nextIdRef.current++;
      const result = await new Promise<ScrubResult>((resolve, reject) => {
        pendingRef.current.set(id, { resolve, reject });
        const request: ScrubberRequest =
          task.type === "scrub"
            ? { type: "scrub", id, text: task.text }
            : { type: "transcribe", id, audio: task.audio };
        worker.postMessage(request);
      });

      await storeRedactedBatch(sessionId, result.entities);

      return {
        redactedText: result.redactedText,
        entities: result.entities.map(({ token, category, confidence }) => ({
          token,
          category,
          confidence,
        })),
      };
    },
    [sessionId],
  );

  const scrubText = useCallback(
    (text: string) => run({ type: "scrub", text }),
    [run],
  );

  const transcribeAndScrub = useCallback(
    (audio: Float32Array) => run({ type: "transcribe", audio }),
    [run],
  );

  return { status, device, progress, error, scrubText, transcribeAndScrub };
}
