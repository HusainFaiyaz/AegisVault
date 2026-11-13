import type { EntityCategory, RedactedEntity } from "@aegis/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  CheckCircle2,
  CircleAlert,
  CloudUpload,
  FileText,
  LoaderCircle,
  Mic,
  ScanEye,
  Square,
  Upload,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import type { ScrubTextFn } from "../hooks/useRedactionSession.js";
import type { RedactionOutcome } from "../hooks/useZeroTrustScrubber.js";
import { apiClient } from "../lib/api.js";
import { startDictation, MAX_DICTATION_SECONDS, type DictationSession } from "../lib/audio-capture.js";
import { describeFailure } from "../lib/chat-session.js";
import { cn } from "../lib/cn.js";
import { buildUploadPayload, fetchJobStatus, scrubFileName, submitDocument } from "../lib/document-ingest.js";
import { ENTITY_STYLES } from "../lib/entity-style.js";
import { REDACTION_PRESETS, type PresetId } from "../lib/presets.js";
import { segmentText } from "../lib/segments.js";
import { inspectEgress } from "../lib/wire-client.js";
import { useWorkspace, type IndexedDocument, type XRayMode } from "../stores/workspace.store.js";
import { HydratedEntityPill } from "./HydratedEntityPill.js";

const MAX_UPLOAD_BYTES = 256 * 1024;

export interface RedactionStudioPaneProps {
  scrubberReady: boolean;
  scrubText: ScrubTextFn;
  transcribeAndScrub: (audio: Float32Array) => Promise<RedactionOutcome>;
}

interface ScrubbedDocument {
  id: string;
  outcome: RedactionOutcome;
  source: "document" | "voice";
  /** Raw file label; scrubbed again before it is uploaded. */
  fileName: string;
  /** The input the result was produced from, to flag stale results. */
  input: string | null;
}

type InputMode = "document" | "voice";

/* ------------------------------------------------------------------ X-Ray */

export interface XRayViewProps {
  redactedText: string;
  vault: ReadonlyMap<string, RedactedEntity>;
  mode: XRayMode;
}

/**
 * Two renderings of one redaction. "raw" re-hydrates every token from the
 * local vault and highlights it (what only this browser can see); "wire"
 * prints the exact `sanitizedContent` the API would receive.
 */
export function XRayView({ redactedText, vault, mode }: XRayViewProps) {
  const lookup = useMemo(
    () => new Map([...vault].map(([token, entity]) => [token, entity.originalValue])),
    [vault],
  );
  const segments = useMemo(() => segmentText(redactedText, lookup), [redactedText, lookup]);

  return (
    <div
      data-xray-mode={mode}
      className={cn(
        "rounded-md border px-4 py-3 text-[13.5px] leading-[1.7] whitespace-pre-wrap",
        mode === "raw" ? "border-stone-200 bg-white text-stone-800" : "border-stone-800 bg-stone-950 font-mono text-[12.5px] text-stone-300",
      )}
    >
      {segments.map((segment, index) => {
        if (segment.type === "text") return <span key={index}>{segment.content}</span>;
        const token = segment.token ?? segment.content;
        if (mode === "wire") {
          return (
            <span key={index} className="rounded-sm bg-teal-400/15 px-0.5 font-semibold text-teal-300">
              {token}
            </span>
          );
        }
        return (
          <HydratedEntityPill key={index} token={token} originalValue={segment.originalValue} entity={vault.get(token)} />
        );
      })}
    </div>
  );
}

/* --------------------------------------------------------------- Ledger */

function EntityLedger({ entities }: { entities: RedactionOutcome["entities"] }) {
  const counts = new Map<EntityCategory, number>();
  for (const entity of entities) counts.set(entity.category, (counts.get(entity.category) ?? 0) + 1);
  if (counts.size === 0) {
    return <p className="text-[12.5px] text-stone-500">No PII detected in this text.</p>;
  }
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-[12.5px] text-stone-700" aria-label="Entities by category">
      {[...counts].map(([category, count]) => (
        <li key={category} className="flex items-center gap-1.5">
          <span className={cn("size-2 rounded-full", ENTITY_STYLES[category].swatch)} aria-hidden />
          {ENTITY_STYLES[category].label}
          <span className="font-semibold tabular-nums text-stone-900">{count}</span>
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------- Indexed docs */

function DocumentStatusRow({ document }: { document: IndexedDocument }) {
  const updateDocument = useWorkspace((state) => state.updateDocument);
  const settled = document.state === "completed" || document.state === "failed";
  const { data, error } = useQuery({
    queryKey: ["ingestion-job", document.jobId],
    queryFn: () => fetchJobStatus(apiClient, document.jobId),
    enabled: !settled,
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      return state === "completed" || state === "failed" ? false : 1200;
    },
    retry: 2,
  });

  useEffect(() => {
    if (data !== undefined && (data.state !== document.state || data.progress !== document.progress)) {
      updateDocument(document.documentId, { state: data.state, progress: data.progress });
    }
  }, [data, document.documentId, document.state, document.progress, updateDocument]);

  return (
    <li className="flex items-center gap-3 py-2 text-[12.5px]">
      <FileText className="size-4 shrink-0 text-stone-400" aria-hidden />
      <span className="min-w-0 flex-1 truncate font-mono text-stone-700" title={document.fileName}>
        {document.fileName}
      </span>
      <span className="tabular-nums text-stone-500">{document.entityCount} tokens</span>
      {document.state === "completed" ? (
        <span className="inline-flex items-center gap-1 font-medium text-teal-700">
          <CheckCircle2 className="size-3.5" aria-hidden /> Indexed
        </span>
      ) : document.state === "failed" || error !== null ? (
        <span className="inline-flex items-center gap-1 font-medium text-rose-700" title={error === null ? undefined : describeFailure(error)}>
          <CircleAlert className="size-3.5" aria-hidden /> {document.state === "failed" ? "Failed" : "Status unavailable"}
        </span>
      ) : (
        <span className="inline-flex items-center gap-1 text-amber-700">
          <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
          {document.state === "queued" ? "Queued" : `Embedding ${Math.round(document.progress)}%`}
        </span>
      )}
    </li>
  );
}

/* ----------------------------------------------------------------- Voice */

function VoiceInput({
  disabled,
  onAudio,
}: {
  disabled: boolean;
  onAudio: (audio: Float32Array) => Promise<void>;
}) {
  const [phase, setPhase] = useState<"idle" | "recording" | "transcribing">("idle");
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<DictationSession | null>(null);

  useEffect(() => {
    if (phase !== "recording") return;
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      const seconds = Math.floor((Date.now() - startedAt) / 1000);
      setElapsed(seconds);
      if (seconds >= MAX_DICTATION_SECONDS) void stop();
    }, 250);
    return () => window.clearInterval(timer);
  }, [phase]);

  useEffect(() => () => sessionRef.current?.cancel(), []);

  async function start(): Promise<void> {
    setError(null);
    try {
      sessionRef.current = await startDictation();
      setElapsed(0);
      setPhase("recording");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Microphone unavailable");
    }
  }

  async function stop(): Promise<void> {
    const session = sessionRef.current;
    if (session === null) return;
    sessionRef.current = null;
    setPhase("transcribing");
    try {
      await onAudio(await session.stop());
    } catch {
      setError("Transcription failed. Try a shorter clip.");
    } finally {
      setPhase("idle");
    }
  }

  return (
    <div className="flex min-h-[11rem] flex-col items-center justify-center gap-3 rounded-md border border-dashed border-stone-300 bg-white px-6 py-6 text-center">
      <button
        type="button"
        disabled={disabled || phase === "transcribing"}
        onClick={() => void (phase === "recording" ? stop() : start())}
        aria-pressed={phase === "recording"}
        className={cn(
          "grid size-14 place-items-center rounded-full text-white transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600 disabled:cursor-not-allowed disabled:opacity-40",
          phase === "recording" ? "bg-rose-600 hover:bg-rose-700" : "bg-stone-900 hover:bg-stone-800",
        )}
      >
        {phase === "transcribing" ? (
          <LoaderCircle className="size-6 animate-spin motion-reduce:animate-none" />
        ) : phase === "recording" ? (
          <Square className="size-5 fill-current" />
        ) : (
          <Mic className="size-6" />
        )}
        <span className="sr-only">{phase === "recording" ? "Stop dictation" : "Start dictation"}</span>
      </button>
      <p className="text-[13px] text-stone-700" aria-live="polite">
        {phase === "recording"
          ? `Recording ${elapsed}s / ${MAX_DICTATION_SECONDS}s. Click to stop.`
          : phase === "transcribing"
            ? "Whisper is transcribing and scrubbing in the worker"
            : "Dictate a note. Whisper runs in this tab; the transcript is scrubbed before the page sees it."}
      </p>
      {error !== null && <p className="text-[12.5px] text-rose-700">{error}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ Pane */

export function RedactionStudioPane({ scrubberReady, scrubText, transcribeAndScrub }: RedactionStudioPaneProps) {
  const vault = useWorkspace((state) => state.vault);
  const xray = useWorkspace((state) => state.xray);
  const setXray = useWorkspace((state) => state.setXray);
  const documents = useWorkspace((state) => state.documents);
  const addDocument = useWorkspace((state) => state.addDocument);
  const sessionId = useWorkspace((state) => state.sessionId);

  const [mode, setMode] = useState<InputMode>("document");
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState("pasted-note.txt");
  const [activePreset, setActivePreset] = useState<PresetId | null>(null);
  const [result, setResult] = useState<ScrubbedDocument | null>(null);
  const [indexedResultIds, setIndexedResultIds] = useState<ReadonlySet<string>>(new Set());
  const [scrubbing, setScrubbing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // A purge rotates the session: drop results whose tokens no longer resolve.
  useEffect(() => {
    setResult(null);
    setIndexedResultIds(new Set());
  }, [sessionId]);

  const stale = result !== null && result.source === "document" && result.input !== text;
  const verdict = useMemo(() => (result === null ? null : inspectEgress(result.outcome.redactedText)), [result]);
  const wireBytes = useMemo(
    () => (result === null ? 0 : new TextEncoder().encode(result.outcome.redactedText).byteLength),
    [result],
  );

  const indexing = useMutation({
    mutationFn: async (doc: ScrubbedDocument) => {
      const safeName = await scrubFileName(doc.fileName, (name) => scrubText(name, { record: false }));
      const payload = buildUploadPayload({
        documentId: crypto.randomUUID(),
        fileName: safeName,
        outcome: doc.outcome,
        uploadedAt: new Date(),
      });
      const accepted = await submitDocument(apiClient, payload);
      return { doc, accepted, safeName };
    },
    onSuccess: ({ doc, accepted, safeName }) => {
      setIndexedResultIds((ids) => new Set(ids).add(doc.id));
      addDocument({
        documentId: accepted.documentId,
        fileName: safeName,
        jobId: accepted.jobId,
        state: "queued",
        progress: 0,
        entityCount: doc.outcome.entities.length,
        submittedAt: Date.now(),
      });
    },
  });

  function loadPreset(id: PresetId): void {
    const preset = REDACTION_PRESETS.find((candidate) => candidate.id === id);
    if (preset === undefined) return;
    setMode("document");
    setText(preset.text);
    setFileName(preset.fileName);
    setActivePreset(id);
    setNotice(null);
  }

  async function runScrub(): Promise<void> {
    if (text.trim().length === 0) return;
    setScrubbing(true);
    setNotice(null);
    try {
      const outcome = await scrubText(text);
      setResult({ id: crypto.randomUUID(), outcome, source: "document", fileName, input: text });
      indexing.reset();
    } catch {
      setNotice("Local scrubbing failed. Nothing was sent anywhere.");
    } finally {
      setScrubbing(false);
    }
  }

  async function handleAudio(audio: Float32Array): Promise<void> {
    const outcome = await transcribeAndScrub(audio);
    setResult({ id: crypto.randomUUID(), outcome, source: "voice", fileName: "voice-dictation.txt", input: null });
    indexing.reset();
  }

  async function handleFile(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file === undefined) return;
    if (file.size > MAX_UPLOAD_BYTES) {
      setNotice(`That file is ${(file.size / 1024).toFixed(0)} KB; the studio accepts plain text up to 256 KB.`);
      return;
    }
    setText(await file.text());
    setFileName(file.name);
    setActivePreset(null);
    setNotice(null);
  }

  const alreadyIndexed = result !== null && indexedResultIds.has(result.id);

  return (
    <section aria-labelledby="studio-heading" className="flex flex-col bg-stone-100/60 lg:min-h-0 lg:overflow-y-auto">
      <div className="flex flex-col gap-5 p-5">
        {/* Header + presets */}
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="studio-heading" className="text-[17px] font-semibold tracking-tight text-stone-900">
              Redaction Studio
            </h2>
            <p className="mt-0.5 text-[13px] text-stone-600">Detect and pseudonymise PII on this device before anything is indexed.</p>
          </div>
          <div className="flex gap-2" role="group" aria-label="Sample documents">
            {REDACTION_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => loadPreset(preset.id)}
                title={preset.framework}
                aria-pressed={activePreset === preset.id}
                className={cn(
                  "rounded-md border px-3 py-1.5 text-[12.5px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600",
                  activePreset === preset.id
                    ? "border-stone-900 bg-stone-900 text-white"
                    : "border-stone-300 bg-white text-stone-800 hover:border-stone-400",
                )}
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>

        {/* Input */}
        <div>
          <div className="mb-2 flex items-center gap-1 border-b border-stone-200" role="tablist" aria-label="Input source">
            {(["document", "voice"] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={mode === tab}
                onClick={() => setMode(tab)}
                className={cn(
                  "-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] font-medium transition-colors",
                  mode === tab ? "border-stone-900 text-stone-900" : "border-transparent text-stone-500 hover:text-stone-800",
                )}
              >
                {tab === "document" ? <FileText className="size-4" aria-hidden /> : <Mic className="size-4" aria-hidden />}
                {tab === "document" ? "Document" : "Voice"}
              </button>
            ))}
            {mode === "document" && (
              <span className="ml-auto truncate pb-1 font-mono text-[11.5px] text-stone-500" title="Local file label">
                {fileName}
              </span>
            )}
          </div>

          {mode === "document" ? (
            <>
              <label htmlFor="studio-input" className="sr-only">
                Document text
              </label>
              <textarea
                id="studio-input"
                value={text}
                onChange={(event) => {
                  setText(event.target.value);
                  setActivePreset(null);
                }}
                spellCheck={false}
                placeholder="Paste a clinical note, contract clause or any text containing personal data, or load a sample above."
                className="block h-52 w-full resize-y rounded-md border border-stone-300 bg-white px-3.5 py-3 text-[13.5px] leading-relaxed text-stone-900 placeholder:text-stone-400 focus:border-stone-500 focus:outline-none"
              />
              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                <input ref={fileInputRef} type="file" accept=".txt,.md,.csv,.json,text/plain" className="sr-only" onChange={(event) => void handleFile(event)} tabIndex={-1} />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="inline-flex items-center gap-1.5 rounded-md border border-stone-300 bg-white px-3 py-2 text-[13px] font-medium text-stone-800 hover:border-stone-400"
                >
                  <Upload className="size-4" aria-hidden /> Open text file
                </button>
                <span className="text-[12px] text-stone-500">Read locally; never uploaded raw.</span>
                <button
                  type="button"
                  onClick={() => void runScrub()}
                  disabled={!scrubberReady || scrubbing || text.trim().length === 0}
                  className="ml-auto inline-flex items-center gap-1.5 rounded-md bg-teal-700 px-4 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-teal-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700 disabled:cursor-not-allowed disabled:bg-stone-300 disabled:text-stone-600"
                >
                  {scrubbing ? <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <ScanEye className="size-4" aria-hidden />}
                  {scrubberReady ? (scrubbing ? "Scrubbing" : "Scrub locally") : "Loading model"}
                </button>
              </div>
            </>
          ) : (
            <VoiceInput disabled={!scrubberReady} onAudio={handleAudio} />
          )}
          {notice !== null && <p className="mt-2 text-[12.5px] text-rose-700">{notice}</p>}
        </div>

        {/* X-Ray */}
        <div>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-[14px] font-semibold text-stone-900">X-Ray</h3>
            <div role="radiogroup" aria-label="X-Ray view" className="inline-flex rounded-md border border-stone-300 bg-white p-0.5 text-[12.5px]">
              {(
                [
                  ["raw", "Raw · PII highlighted"],
                  ["wire", "Cloud wire view"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={xray === value}
                  onClick={() => setXray(value)}
                  className={cn(
                    "rounded px-2.5 py-1 font-medium transition-colors",
                    xray === value ? (value === "wire" ? "bg-stone-900 text-teal-300" : "bg-stone-200 text-stone-900") : "text-stone-600 hover:text-stone-900",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {result === null ? (
            <div className="rounded-md border border-dashed border-stone-300 bg-white/60 px-4 py-8 text-center text-[13px] text-stone-500">
              Scrub a document or dictation to compare what you see with what the server receives.
            </div>
          ) : (
            <>
              {stale && (
                <p className="mb-2 text-[12.5px] text-amber-800">The text changed since this scrub. Scrub again before indexing.</p>
              )}
              <XRayView redactedText={result.outcome.redactedText} vault={vault} mode={xray} />
              <div className="mt-2.5 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                <EntityLedger entities={result.outcome.entities} />
                {verdict !== null && (
                  <span className={cn("text-[12px] font-medium", verdict.clean ? "text-teal-700" : "text-rose-700")}>
                    {verdict.clean
                      ? `Guard: no raw PII patterns · ${wireBytes.toLocaleString()} bytes`
                      : `Guard would block: ${verdict.categories.join(", ")}`}
                  </span>
                )}
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-stone-200 pt-4">
                <button
                  type="button"
                  disabled={indexing.isPending || stale || alreadyIndexed || verdict?.clean !== true}
                  onClick={() => indexing.mutate(result)}
                  className="inline-flex items-center gap-1.5 rounded-md bg-stone-900 px-4 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-stone-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900 disabled:cursor-not-allowed disabled:bg-stone-300 disabled:text-stone-600"
                >
                  {indexing.isPending ? <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <CloudUpload className="size-4" aria-hidden />}
                  {alreadyIndexed ? "Sent for indexing" : "Index sanitized copy"}
                </button>
                <span className="text-[12px] text-stone-500">Uploads the wire view only: tokens, categories and confidences.</span>
                {indexing.isError && <p className="w-full text-[12.5px] text-rose-700">{describeFailure(indexing.error)}</p>}
              </div>
            </>
          )}
        </div>

        {documents.length > 0 && (
          <div>
            <h3 className="mb-1 text-[14px] font-semibold text-stone-900">Indexed this session</h3>
            <ul className="divide-y divide-stone-200 rounded-md border border-stone-200 bg-white px-3">
              {documents.map((document) => (
                <DocumentStatusRow key={document.documentId} document={document} />
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
