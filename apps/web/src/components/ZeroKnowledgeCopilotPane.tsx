import type { RedactedEntity } from "@aegis/shared";
import { ArrowUp, BadgeCheck, CircleAlert, FileSearch, LoaderCircle, Square, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { RedactionOutcome } from "../hooks/useZeroTrustScrubber.js";
import { apiClient } from "../lib/api.js";
import type { ChatHistoryTurn, GroundingEvent, StreamCitation } from "../lib/chat-protocol.js";
import { runChatTurn, type AssistantDraft } from "../lib/chat-session.js";
import { cn } from "../lib/cn.js";
import { REDACTION_PRESETS } from "../lib/presets.js";
import { segmentText, toRenderSegments, type RenderSegment } from "../lib/segments.js";
import type { EntityLookupMap } from "../lib/stream-rehydrator.js";
import { useWorkspace } from "../stores/workspace.store.js";
import { HydratedEntityPill } from "./HydratedEntityPill.js";

export interface ZeroKnowledgeCopilotPaneProps {
  scrubberReady: boolean;
  scrubText: (text: string) => Promise<RedactionOutcome>;
  loadLookup: () => Promise<EntityLookupMap>;
}

interface Turn {
  id: string;
  /** Tokenised question as sent; null until the local scrub finishes. */
  redactedQuery: string | null;
  draft: AssistantDraft;
}

function vaultLookup(vault: ReadonlyMap<string, RedactedEntity>): EntityLookupMap {
  return new Map([...vault].map(([token, entity]) => [token, entity.originalValue]));
}

/* ------------------------------------------------------------ Rendering */

function RichText({
  segments,
  vault,
  activeMarker,
  onCitation,
}: {
  segments: readonly RenderSegment[];
  vault: ReadonlyMap<string, RedactedEntity>;
  activeMarker?: string | null;
  onCitation?: (marker: string) => void;
}) {
  return (
    <>
      {segments.map((segment, index) => {
        if (segment.type === "text") return <span key={index}>{segment.content}</span>;
        if (segment.type === "entity") {
          return (
            <HydratedEntityPill key={index} token={segment.token} originalValue={segment.originalValue} entity={vault.get(segment.token)} />
          );
        }
        const number = segment.marker.slice(5, -1);
        return (
          <button
            key={index}
            type="button"
            onClick={() => onCitation?.(segment.marker)}
            aria-label={`Source ${number}`}
            className={cn(
              "mx-0.5 inline-grid h-[18px] min-w-[18px] -translate-y-px place-items-center rounded px-1 align-middle font-mono text-[10.5px] font-semibold transition-colors",
              activeMarker === segment.marker ? "bg-teal-700 text-white" : "bg-stone-200 text-stone-700 hover:bg-stone-300",
            )}
          >
            {Number(number)}
          </button>
        );
      })}
    </>
  );
}

function GroundingSummary({ grounding }: { grounding: GroundingEvent }) {
  const problems = [
    grounding.unknownTokens.length > 0 && `${grounding.unknownTokens.length} invented placeholder(s)`,
    grounding.malformedTokens.length > 0 && `${grounding.malformedTokens.length} mangled placeholder(s)`,
    grounding.invalidCitations.length > 0 && `${grounding.invalidCitations.length} citation(s) to missing sources`,
    grounding.rawPiiCategories.length > 0 && `raw ${grounding.rawPiiCategories.join(", ")} in answer`,
  ].filter((item): item is string => typeof item === "string");

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-2.5 py-1.5 text-[12px]",
        grounding.grounded ? "bg-teal-50 text-teal-900" : "bg-amber-50 text-amber-900",
      )}
    >
      <span className="inline-flex items-center gap-1 font-semibold">
        {grounding.grounded ? <BadgeCheck className="size-3.5" aria-hidden /> : <TriangleAlert className="size-3.5" aria-hidden />}
        {grounding.grounded ? "Grounded" : "Needs review"}
      </span>
      <span className="tabular-nums">
        {grounding.citedSentenceCount}/{grounding.sentenceCount} sentences cited
      </span>
      <span className="tabular-nums">{grounding.preservedTokens.length} placeholders preserved</span>
      {problems.length > 0 && <span>{problems.join(" · ")}</span>}
    </div>
  );
}

function SourceList({
  citations,
  vault,
  activeMarker,
  onSelect,
}: {
  citations: readonly StreamCitation[];
  vault: ReadonlyMap<string, RedactedEntity>;
  activeMarker: string | null;
  onSelect: (marker: string | null) => void;
}) {
  const lookup = useMemo(() => vaultLookup(vault), [vault]);
  if (citations.length === 0) return null;
  return (
    <details className="group/sources mt-3 rounded-md border border-stone-200 bg-stone-50" open={activeMarker !== null}>
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-2 text-[12.5px] font-medium text-stone-700">
        <FileSearch className="size-3.5" aria-hidden />
        {citations.length} reranked sources
        <span className="ml-auto text-[11.5px] font-normal text-stone-500 group-open/sources:hidden">Show</span>
      </summary>
      <ol className="divide-y divide-stone-200 border-t border-stone-200">
        {citations.map((citation) => (
          <li
            key={citation.chunkId}
            className={cn("px-3 py-2.5 text-[12.5px] transition-colors", activeMarker === citation.citationMarker && "bg-teal-50")}
          >
            <button
              type="button"
              onClick={() => onSelect(activeMarker === citation.citationMarker ? null : citation.citationMarker)}
              className="flex w-full items-baseline gap-2 text-left"
            >
              <span className="font-mono text-[11px] font-semibold text-stone-500">{Number(citation.citationMarker.slice(5, -1))}</span>
              <span className="min-w-0 flex-1 truncate font-medium text-stone-800">{citation.sectionTitle}</span>
              <span className="tabular-nums text-[11px] text-stone-500">{citation.score.toFixed(3)}</span>
            </button>
            <p className="mt-0.5 truncate pl-5 font-mono text-[11px] text-stone-500">{citation.fileName}</p>
            <p className="mt-1.5 line-clamp-3 pl-5 leading-relaxed text-stone-700">
              <RichText segments={toRenderSegments(segmentText(citation.sanitizedContent, lookup))} vault={vault} />
            </p>
          </li>
        ))}
      </ol>
    </details>
  );
}

function AssistantMessage({ draft, vault }: { draft: AssistantDraft; vault: ReadonlyMap<string, RedactedEntity> }) {
  const [activeMarker, setActiveMarker] = useState<string | null>(null);
  const segments = useMemo(() => toRenderSegments(draft.segments), [draft.segments]);
  const working = draft.phase === "scrubbing" || draft.phase === "retrieving" || draft.phase === "streaming";

  return (
    <div className="max-w-full">
      {segments.length === 0 && working && (
        <p className="inline-flex items-center gap-2 text-[13px] text-stone-500" aria-live="polite">
          <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
          {draft.phase === "scrubbing"
            ? "Scrubbing your question on this device"
            : draft.phase === "retrieving"
              ? "Retrieving with hybrid search and reranking"
              : "Waiting for the first token"}
        </p>
      )}
      {segments.length > 0 && (
        <div className="text-[14px] leading-[1.7] whitespace-pre-wrap text-stone-900">
          <RichText segments={segments} vault={vault} activeMarker={activeMarker} onCitation={setActiveMarker} />
          {draft.phase === "streaming" && (
            <span className="ml-0.5 inline-block h-4 w-[7px] translate-y-0.5 animate-pulse bg-teal-600 motion-reduce:animate-none" aria-hidden />
          )}
        </div>
      )}
      {draft.phase === "aborted" && <p className="mt-1 text-[12.5px] text-stone-500">Stopped.</p>}
      {draft.error !== null && (
        <p className="mt-2 flex items-start gap-1.5 text-[12.5px] text-rose-700">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {draft.error}
        </p>
      )}
      {draft.grounding !== null && (
        <div className="mt-3">
          <GroundingSummary grounding={draft.grounding} />
        </div>
      )}
      {draft.retrieval !== null && (
        <SourceList citations={draft.retrieval.citations} vault={vault} activeMarker={activeMarker} onSelect={setActiveMarker} />
      )}
      {draft.done !== null && draft.retrieval !== null && (
        <p className="mt-2 text-[11.5px] text-stone-500 tabular-nums">
          {draft.retrieval.model} · retrieval {Math.round(draft.done.latency.retrievalMs)} ms ({draft.retrieval.retrieval.fusionSource}) · first token{" "}
          {draft.done.latency.timeToFirstTokenMs === null ? "n/a" : `${Math.round(draft.done.latency.timeToFirstTokenMs)} ms`} · total{" "}
          {Math.round(draft.done.latency.totalMs)} ms
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ Pane */

/**
 * Right pane: grounded chat over indexed documents. Questions are scrubbed
 * locally first (they can name patients too), the tokenised question is
 * streamed through the guarded wire client, and placeholders in the answer
 * are re-hydrated from the vault as the deltas arrive.
 */
export function ZeroKnowledgeCopilotPane({ scrubberReady, scrubText, loadLookup }: ZeroKnowledgeCopilotPaneProps) {
  const vault = useWorkspace((state) => state.vault);
  const documents = useWorkspace((state) => state.documents);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState("");
  const [scopeToSession, setScopeToSession] = useState(true);
  const abortRef = useRef<AbortController | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);

  const indexedIds = documents.filter((document) => document.state === "completed").map((document) => document.documentId);
  const busy = turns.at(-1)?.draft.phase === "scrubbing" || turns.at(-1)?.draft.phase === "retrieving" || turns.at(-1)?.draft.phase === "streaming";
  const lookup = useMemo(() => vaultLookup(vault), [vault]);

  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => {
    const node = transcriptRef.current;
    if (node !== null) node.scrollTop = node.scrollHeight;
  }, [turns]);

  async function ask(text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed.length === 0 || busy || !scrubberReady) return;

    const history: ChatHistoryTurn[] = turns.flatMap((turn) =>
      turn.redactedQuery === null || turn.draft.phase !== "done"
        ? []
        : [
            { role: "user" as const, content: turn.redactedQuery },
            { role: "assistant" as const, content: turn.draft.wireText },
          ],
    );
    const id = crypto.randomUUID();
    const controller = new AbortController();
    abortRef.current = controller;
    setQuestion("");
    const patch = (update: Partial<Turn>): void =>
      setTurns((current) => current.map((turn) => (turn.id === id ? { ...turn, ...update } : turn)));
    setTurns((current) => [...current, { id, redactedQuery: null, draft: { phase: "scrubbing", segments: [], wireText: "", retrieval: null, grounding: null, done: null, error: null } }]);

    await runChatTurn(
      { question: trimmed, documentIds: scopeToSession ? indexedIds : [], history, signal: controller.signal },
      { scrub: scrubText, loadLookup, client: apiClient },
      {
        onQueryRedacted: (outcome) => patch({ redactedQuery: outcome.redactedText }),
        onDraft: (draft) => patch({ draft }),
      },
    );
  }

  function submit(event: FormEvent): void {
    event.preventDefault();
    void ask(question);
  }

  const suggestions = REDACTION_PRESETS.flatMap((preset) => preset.suggestedQuestions);

  return (
    <section aria-labelledby="copilot-heading" className="flex flex-col border-t border-stone-200 bg-white lg:min-h-0 lg:border-t-0">
      <div className="flex flex-wrap items-end justify-between gap-2 border-b border-stone-200 px-5 pt-5 pb-3">
        <div>
          <h2 id="copilot-heading" className="text-[17px] font-semibold tracking-tight text-stone-900">
            Zero-Knowledge Copilot
          </h2>
          <p className="mt-0.5 text-[13px] text-stone-600">The model reads tokens. You read names, re-hydrated in this browser.</p>
        </div>
        {indexedIds.length > 0 && (
          <label className="inline-flex cursor-pointer items-center gap-2 text-[12.5px] text-stone-700">
            <input
              type="checkbox"
              checked={scopeToSession}
              onChange={(event) => setScopeToSession(event.target.checked)}
              className="size-3.5 accent-teal-700"
            />
            Only this session's {indexedIds.length} {indexedIds.length === 1 ? "document" : "documents"}
          </label>
        )}
      </div>

      <div ref={transcriptRef} className="min-h-[50vh] px-5 py-5 lg:min-h-0 lg:flex-1 lg:overflow-y-auto" aria-live="polite" aria-busy={busy}>
        {turns.length === 0 ? (
          <div className="mx-auto max-w-md pt-6">
            <p className="text-[13.5px] leading-relaxed text-stone-600">
              Index a scrubbed document on the left, then ask about it. Names and identifiers in your question are tokenised before
              sending, so the API can match them against the index without learning who they are.
            </p>
            <ul className="mt-4 space-y-2">
              {suggestions.map((suggestion) => (
                <li key={suggestion}>
                  <button
                    type="button"
                    disabled={!scrubberReady}
                    onClick={() => void ask(suggestion)}
                    className="w-full rounded-md border border-stone-200 px-3 py-2 text-left text-[13px] text-stone-800 transition-colors hover:border-stone-400 hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {suggestion}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <ol className="space-y-6">
            {turns.map((turn) => (
              <li key={turn.id} className="space-y-3">
                <div className="ml-auto w-fit max-w-[85%] rounded-lg bg-stone-900 px-3.5 py-2 text-[14px] leading-relaxed text-stone-50">
                  {turn.redactedQuery === null ? (
                    <span className="text-stone-400">Scrubbing locally…</span>
                  ) : (
                    <RichText segments={toRenderSegments(segmentText(turn.redactedQuery, lookup))} vault={vault} />
                  )}
                </div>
                <AssistantMessage draft={turn.draft} vault={vault} />
              </li>
            ))}
          </ol>
        )}
      </div>

      <form onSubmit={submit} className="border-t border-stone-200 p-4">
        <div className="flex items-end gap-2 rounded-lg border border-stone-300 bg-white p-1.5 focus-within:border-stone-500">
          <label htmlFor="copilot-input" className="sr-only">
            Ask about your documents
          </label>
          <textarea
            id="copilot-input"
            rows={2}
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void ask(question);
              }
            }}
            placeholder={scrubberReady ? "Ask about an indexed document. Names are tokenised before sending." : "Waiting for the local model…"}
            className="min-h-[2.5rem] flex-1 resize-none bg-transparent px-2 py-1.5 text-[14px] text-stone-900 placeholder:text-stone-400 focus:outline-none"
          />
          {busy ? (
            <button
              type="button"
              onClick={() => abortRef.current?.abort()}
              className="grid size-9 place-items-center rounded-md bg-stone-200 text-stone-800 hover:bg-stone-300"
            >
              <Square className="size-3.5 fill-current" aria-hidden />
              <span className="sr-only">Stop</span>
            </button>
          ) : (
            <button
              type="submit"
              disabled={!scrubberReady || question.trim().length === 0}
              className="grid size-9 place-items-center rounded-md bg-teal-700 text-white hover:bg-teal-800 disabled:cursor-not-allowed disabled:bg-stone-300"
            >
              <ArrowUp className="size-4" aria-hidden />
              <span className="sr-only">Send</span>
            </button>
          )}
        </div>
      </form>
    </section>
  );
}
