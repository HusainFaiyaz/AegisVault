import { ChevronDown, ChevronUp, ShieldAlert, ShieldCheck, Trash } from "lucide-react";
import { useMemo } from "react";
import { cn } from "../lib/cn.js";
import { inspectInbound, type WireExchange } from "../lib/wire-client.js";
import { useNetworkLog } from "../stores/network-log.store.js";
import { useWorkspace } from "../stores/workspace.store.js";

function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

function pathOf(url: string): string {
  try {
    return new URL(url, "http://local").pathname;
  } catch {
    return url;
  }
}

/** Pretty-prints JSON for reading; the byte count shown is of the exact original. */
function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text) as unknown, null, 2);
  } catch {
    return text;
  }
}

const STATUS_STYLE: Readonly<Record<WireExchange["status"], string>> = {
  blocked: "bg-rose-100 text-rose-800",
  pending: "bg-amber-100 text-amber-800",
  streaming: "bg-sky-100 text-sky-800",
  complete: "bg-teal-100 text-teal-800",
  failed: "bg-rose-100 text-rose-800",
  aborted: "bg-stone-200 text-stone-700",
};

function ExchangeRow({ exchange, selected, onSelect }: { exchange: WireExchange; selected: boolean; onSelect: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected}
        className={cn(
          "grid w-full grid-cols-[auto_1fr_auto] items-center gap-x-2 px-3 py-2 text-left text-[12px] transition-colors",
          selected ? "bg-stone-800" : "hover:bg-stone-800/60",
        )}
      >
        <span className="font-mono text-[11px] font-semibold text-stone-400">{exchange.method}</span>
        <span className="truncate font-mono text-stone-200">{pathOf(exchange.url)}</span>
        <span className={cn("rounded px-1.5 py-px text-[10.5px] font-semibold", STATUS_STYLE[exchange.status])}>
          {exchange.status === "blocked" ? "blocked" : exchange.httpStatus ?? exchange.status}
        </span>
        <span className="col-span-3 mt-0.5 flex gap-2 text-[11px] text-stone-500">
          <span>{exchange.label}</span>
          <span className="tabular-nums">↑ {formatBytes(exchange.requestBytes)}</span>
          {exchange.durationMs !== null && <span className="tabular-nums">{Math.round(exchange.durationMs)} ms</span>}
        </span>
      </button>
    </li>
  );
}

function VerdictLine({ clean, categories, direction }: { clean: boolean; categories: readonly string[]; direction: "outbound" | "inbound" }) {
  return (
    <p className={cn("flex items-center gap-1.5 text-[11.5px] font-medium", clean ? "text-teal-300" : "text-rose-300")}>
      {clean ? <ShieldCheck className="size-3.5" aria-hidden /> : <ShieldAlert className="size-3.5" aria-hidden />}
      {clean
        ? `Guard scan: 0 raw PII patterns ${direction === "outbound" ? "in the request" : "in the response"}`
        : `Guard scan: raw ${categories.join(", ")} detected`}
    </p>
  );
}

export function ExchangeDetail({ exchange }: { exchange: WireExchange }) {
  const inbound = useMemo(
    () => (exchange.chunks.length > 0 ? exchange.chunks.map((chunk) => chunk.text).join("") : exchange.responseBody ?? ""),
    [exchange.chunks, exchange.responseBody],
  );
  const inboundVerdict = useMemo(
    () => inspectInbound(inbound, exchange.chunks.length > 0 ? "event-stream" : "json"),
    [inbound, exchange.chunks.length],
  );

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 gap-px bg-stone-800 md:grid-cols-2">
      <div className="flex min-h-0 flex-col bg-stone-950">
        <div className="flex items-center justify-between gap-2 border-b border-stone-800 px-3 py-2">
          <h4 className="text-[12px] font-semibold text-stone-200">Outbound payload</h4>
          <span className="font-mono text-[11px] text-stone-500">
            {exchange.method} {pathOf(exchange.url)} · {formatBytes(exchange.requestBytes)}
          </span>
        </div>
        <div className="border-b border-stone-800 px-3 py-1.5">
          <VerdictLine clean={exchange.verdict.clean} categories={exchange.verdict.categories} direction="outbound" />
        </div>
        <pre className="min-h-0 flex-1 overflow-auto px-3 py-2 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap break-all text-stone-300">
          {exchange.status === "blocked"
            ? "Not sent. The browser refused this request before fetch(); the payload was discarded and is not kept here."
            : exchange.requestBody === null
              ? "(no body)"
              : prettyJson(exchange.requestBody)}
        </pre>
      </div>

      <div className="flex min-h-0 flex-col bg-stone-950">
        <div className="flex items-center justify-between gap-2 border-b border-stone-800 px-3 py-2">
          <h4 className="text-[12px] font-semibold text-stone-200">
            {exchange.chunks.length > 0 ? "Inbound SSE stream (raw chunks)" : "Inbound response"}
          </h4>
          <span className="font-mono text-[11px] text-stone-500">
            {exchange.chunks.length > 0 ? `${exchange.chunks.length} chunks · ` : ""}
            {formatBytes(new TextEncoder().encode(inbound).byteLength)}
          </span>
        </div>
        <div className="border-b border-stone-800 px-3 py-1.5">
          {inbound.length > 0 ? (
            <VerdictLine clean={inboundVerdict.clean} categories={inboundVerdict.categories} direction="inbound" />
          ) : (
            <p className="text-[11.5px] text-stone-500">{exchange.error ?? "Waiting for the response"}</p>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
          {exchange.chunks.length > 0 ? (
            <ol className="space-y-1">
              {exchange.chunks.map((chunk, index) => (
                <li key={index} className="grid grid-cols-[3.75rem_1fr] gap-2">
                  <span className="pt-px text-right font-mono text-[10.5px] text-stone-600 tabular-nums">+{Math.round(chunk.at)}ms</span>
                  <pre className="rounded-sm border-l-2 border-sky-700/70 bg-stone-900 px-2 py-1 font-mono text-[11px] leading-snug whitespace-pre-wrap break-all text-stone-300">
                    {chunk.text}
                  </pre>
                </li>
              ))}
            </ol>
          ) : (
            <pre className="font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap break-all text-stone-300">
              {exchange.responseBody === null ? "" : prettyJson(exchange.responseBody)}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

export interface NetworkProofPanelProps {
  exchanges: readonly WireExchange[];
  selectedId: string | null;
  open: boolean;
  onToggle: () => void;
  onSelect: (id: string) => void;
  onClear: () => void;
}

/** Presentational drawer; `NetworkProofDrawer` binds it to the stores. */
export function NetworkProofPanel({ exchanges, selectedId, open, onToggle, onSelect, onClear }: NetworkProofPanelProps) {
  const sent = exchanges.filter((exchange) => exchange.status !== "blocked");
  const blocked = exchanges.length - sent.length;
  const leaks = sent.filter((exchange) => !exchange.verdict.clean).length;
  const selected = exchanges.find((exchange) => exchange.id === selectedId) ?? exchanges.at(-1) ?? null;

  return (
    <section
      aria-label="Network proof"
      className={cn("flex flex-col border-t border-stone-800 bg-stone-900 text-stone-200", open ? "h-[42vh] min-h-[260px]" : "h-auto")}
    >
      <div className="flex items-center gap-3 px-4 py-2">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="inline-flex items-center gap-2 text-[13px] font-semibold text-stone-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-400"
        >
          {open ? <ChevronDown className="size-4" aria-hidden /> : <ChevronUp className="size-4" aria-hidden />}
          Network proof
        </button>
        <span className="text-[12px] text-stone-400 tabular-nums">
          {`${sent.length} sent · ${blocked} blocked in browser · `}
          <span className={leaks === 0 ? "text-teal-300" : "text-rose-300"}>
            {leaks === 0 ? "0 raw PII on the wire" : `${leaks} with raw PII`}
          </span>
        </span>
        {open && exchanges.length > 0 && (
          <button type="button" onClick={onClear} className="ml-auto inline-flex items-center gap-1 text-[12px] text-stone-400 hover:text-stone-200">
            <Trash className="size-3.5" aria-hidden /> Clear
          </button>
        )}
      </div>

      {open && (
        <div className="flex min-h-0 flex-1 border-t border-stone-800">
          {exchanges.length === 0 ? (
            <p className="m-auto max-w-sm px-4 text-center text-[12.5px] text-stone-500">
              Nothing has been sent yet. Scrubbing happens on this device; requests appear here only when you index a document or
              ask the copilot.
            </p>
          ) : (
            <>
              <ol className="w-64 shrink-0 overflow-y-auto border-r border-stone-800 max-md:hidden">
                {[...exchanges].reverse().map((exchange) => (
                  <ExchangeRow key={exchange.id} exchange={exchange} selected={exchange.id === selected?.id} onSelect={() => onSelect(exchange.id)} />
                ))}
              </ol>
              {selected !== null && <ExchangeDetail exchange={selected} />}
            </>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * Bottom drawer that shows what actually crossed the network: each request
 * body exactly as sent (and every request the browser refused to send), and
 * each SSE chunk exactly as it arrived, with the shared PII guard re-run on
 * both directions.
 */
export function NetworkProofDrawer() {
  const exchanges = useNetworkLog((state) => state.exchanges);
  const selectedId = useNetworkLog((state) => state.selectedId);
  const select = useNetworkLog((state) => state.select);
  const clear = useNetworkLog((state) => state.clear);
  const open = useWorkspace((state) => state.drawerOpen);
  const setOpen = useWorkspace((state) => state.setDrawerOpen);

  return (
    <NetworkProofPanel
      exchanges={exchanges}
      selectedId={selectedId}
      open={open}
      onToggle={() => setOpen(!open)}
      onSelect={select}
      onClear={clear}
    />
  );
}
