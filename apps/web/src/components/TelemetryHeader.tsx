import { Cpu, Gauge, LoaderCircle, Lock, LockOpen, ShieldCheck, Trash2, TriangleAlert } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { ModelDownloadProgress, ScrubberStatus } from "../hooks/useZeroTrustScrubber.js";
import { cn } from "../lib/cn.js";
import type { ScrubMeasurement } from "../stores/workspace.store.js";
import { describePrecision, type InferenceDevice } from "../workers/model-config.js";

export interface TelemetryHeaderProps {
  status: ScrubberStatus;
  device: InferenceDevice | null;
  progress: ModelDownloadProgress | null;
  error: string | null;
  vaultEntityCount: number;
  vaultLoaded: boolean;
  lastScrub: ScrubMeasurement | null;
  sessionId: string;
  purging: boolean;
  onPurge: () => void;
}

/** Seconds the purge button stays armed after the first click. */
const PURGE_CONFIRM_SECONDS = 4;

function Badge({
  icon,
  label,
  value,
  tone = "neutral",
  title,
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  tone?: "neutral" | "good" | "warn" | "bad";
  title?: string | undefined;
}) {
  return (
    <div
      title={title}
      className={cn(
        "flex min-w-0 items-center gap-2 rounded-md border px-2.5 py-1.5",
        tone === "neutral" && "border-stone-200 bg-white",
        tone === "good" && "border-teal-200 bg-teal-50/70",
        tone === "warn" && "border-amber-200 bg-amber-50",
        tone === "bad" && "border-rose-200 bg-rose-50",
      )}
    >
      <span
        className={cn(
          "shrink-0",
          tone === "good" && "text-teal-700",
          tone === "warn" && "text-amber-700",
          tone === "bad" && "text-rose-700",
          tone === "neutral" && "text-stone-500",
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 leading-tight">
        <span className="block text-[10.5px] font-medium text-stone-500">{label}</span>
        <span className="block truncate text-[12.5px] font-semibold text-stone-900 tabular-nums">{value}</span>
      </span>
    </div>
  );
}

function ModelBadge({ status, device, progress, error }: Pick<TelemetryHeaderProps, "status" | "device" | "progress" | "error">) {
  if (status === "error") {
    return (
      <Badge
        icon={<TriangleAlert className="size-4" />}
        label="Edge model"
        value="Failed to load"
        tone="bad"
        title={error ?? undefined}
      />
    );
  }
  if (status === "loading" || device === null) {
    const pct = progress === null ? null : Math.round(progress.progress);
    return (
      <Badge
        icon={<LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />}
        label="Edge model · downloading once, cached"
        value={pct === null ? "Initialising" : `${progress?.file.split("/").at(-1) ?? "weights"} ${pct}%`}
        tone="warn"
      />
    );
  }
  const precision = describePrecision(device);
  return (
    <Badge
      icon={<Cpu className="size-4" />}
      label={device === "webgpu" ? "WebGPU edge inference" : "WASM edge inference (no WebGPU)"}
      value={`NER ${precision.ner} · Whisper ${precision.asr}`}
      tone="good"
      title="Models run in a Web Worker in this tab; text and audio are never uploaded for detection."
    />
  );
}

/**
 * Live security telemetry for the session: where inference runs and at what
 * precision, whether the vault holds sealed entities, how long the last
 * local scrub took, and the destructive "Purge Vault" control (two-step).
 */
export function TelemetryHeader(props: TelemetryHeaderProps) {
  const { vaultEntityCount, vaultLoaded, lastScrub, sessionId, purging, onPurge } = props;
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), PURGE_CONFIRM_SECONDS * 1000);
    return () => window.clearTimeout(timer);
  }, [armed]);

  const sealed = vaultEntityCount > 0;

  return (
    <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-stone-200 bg-stone-50 px-4 py-2.5">
      <div className="mr-auto flex items-center gap-2.5">
        <span className="grid size-8 place-items-center rounded-md bg-stone-900 text-teal-300">
          <ShieldCheck className="size-[18px]" aria-hidden />
        </span>
        <div className="leading-tight">
          <h1 className="text-[15px] font-semibold tracking-tight text-stone-900">AegisVault</h1>
          <p className="text-[11.5px] text-stone-500">
            Zero-trust studio · session <span className="font-mono">{sessionId.slice(0, 8)}</span>
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <ModelBadge status={props.status} device={props.device} progress={props.progress} error={props.error} />
        <Badge
          icon={sealed ? <Lock className="size-4" /> : <LockOpen className="size-4" />}
          label="Local vault · AES-GCM-256"
          value={
            !vaultLoaded ? "Opening" : sealed ? `Sealed · ${vaultEntityCount} ${vaultEntityCount === 1 ? "entity" : "entities"}` : "Empty"
          }
          tone={sealed ? "good" : "neutral"}
          title="Token-to-value mappings are encrypted with a non-extractable key in IndexedDB."
        />
        <Badge
          icon={<Gauge className="size-4" />}
          label={lastScrub?.kind === "voice" ? "Last scrub (incl. transcription)" : "Last scrub"}
          value={
            lastScrub === null
              ? "No scrub yet"
              : `${lastScrub.ms < 1000 ? `${Math.round(lastScrub.ms)} ms` : `${(lastScrub.ms / 1000).toFixed(2)} s`} · ${lastScrub.entityCount} found`
          }
        />
        <button
          type="button"
          disabled={purging || !vaultLoaded}
          onClick={() => {
            if (armed) {
              setArmed(false);
              onPurge();
            } else {
              setArmed(true);
            }
          }}
          className={cn(
            "inline-flex h-[42px] items-center gap-1.5 rounded-md border px-3 text-[13px] font-medium transition-colors",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-600 disabled:cursor-not-allowed disabled:opacity-50",
            armed
              ? "border-rose-700 bg-rose-700 text-white hover:bg-rose-800"
              : "border-stone-300 bg-white text-stone-800 hover:border-rose-300 hover:bg-rose-50 hover:text-rose-800",
          )}
        >
          {purging ? <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" /> : <Trash2 className="size-4" />}
          {purging ? "Purging" : armed ? "Confirm purge" : "Purge Vault"}
        </button>
      </div>
    </header>
  );
}
