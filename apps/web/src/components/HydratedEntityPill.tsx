import type { EntityCategory, RedactedEntity } from "@aegis/shared";
import { KeyRound, LockKeyhole, ShieldQuestion } from "lucide-react";
import { useId } from "react";
import { cn } from "../lib/cn.js";
import { ENTITY_STYLES, UNRESOLVED_STYLE } from "../lib/entity-style.js";
import { categoryOfToken } from "../lib/segments.js";

export interface HydratedEntityPillProps {
  /** The placeholder exactly as it travelled, e.g. `[PER_89A1]`. */
  token: string;
  /** Real value from the decrypted vault; undefined when this browser cannot resolve it. */
  originalValue: string | undefined;
  /** Vault record, for confidence. Optional: streamed tokens may only carry a value. */
  entity?: RedactedEntity | undefined;
}

const NER_CATEGORIES: ReadonlySet<EntityCategory> = new Set(["PER", "ORG", "LOC"]);

/**
 * Regex detections are exact matches; NER scores are probabilities, floored
 * (not rounded) so 0.9996 never reads as a certain 100%.
 */
export function formatConfidence(confidence: number | undefined, category: EntityCategory | null): string {
  if (confidence === undefined) return "n/a";
  if (category !== null && !NER_CATEGORIES.has(category)) return "Exact match · regex";
  return `${(Math.floor(confidence * 1000) / 10).toFixed(1)}% · NER`;
}

/**
 * A re-hydrated entity inside text. Shows the decrypted real value; hover or
 * keyboard focus reveals what actually crossed the wire (the token), the
 * detector's confidence and where the value came from. A token this vault
 * cannot resolve (another session, purged, or invented by the model) stays
 * visibly a token.
 */
export function HydratedEntityPill({ token, originalValue, entity }: HydratedEntityPillProps) {
  const popoverId = useId();
  const category = entity?.category ?? categoryOfToken(token);
  const style = category === null ? null : ENTITY_STYLES[category];
  const resolved = originalValue !== undefined;

  return (
    <span className="group/pill relative inline-block align-baseline">
      <button
        type="button"
        aria-describedby={popoverId}
        data-token={token}
        data-resolved={resolved}
        className={cn(
          "mx-px inline-flex items-baseline gap-1 rounded px-1 py-px text-[0.95em] leading-snug ring-1 ring-inset",
          "cursor-help transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-teal-600",
          resolved && style !== null ? style.className : UNRESOLVED_STYLE,
          !resolved && "font-mono text-[0.85em]",
        )}
      >
        {resolved ? originalValue : token}
      </button>
      <span
        id={popoverId}
        role="tooltip"
        className={cn(
          "pointer-events-none invisible absolute top-full left-0 z-30 mt-1.5 w-64 rounded-md border border-stone-200 bg-white p-3 text-left text-xs leading-relaxed text-stone-700 opacity-0 shadow-lg",
          "transition-opacity duration-100 group-hover/pill:visible group-hover/pill:opacity-100 group-focus-within/pill:visible group-focus-within/pill:opacity-100",
        )}
      >
        <span className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-medium text-stone-500">On the wire</span>
          <span className="font-mono text-[12px] font-semibold text-stone-900">{token}</span>
        </span>
        <span className="mt-1 flex items-center justify-between gap-2">
          <span className="text-[11px] font-medium text-stone-500">Category</span>
          <span>{style?.label ?? "Unknown"}</span>
        </span>
        {resolved ? (
          <>
            <span className="mt-1 flex items-center justify-between gap-2">
              <span className="text-[11px] font-medium text-stone-500">Confidence</span>
              <span>{formatConfidence(entity?.confidence, category)}</span>
            </span>
            <span className="mt-2 flex items-start gap-1.5 border-t border-stone-100 pt-2 text-teal-800">
              <LockKeyhole aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              <span>
                Decrypted in this browser from the AES-GCM-256 vault. The API only ever saw the token.
              </span>
            </span>
          </>
        ) : (
          <span className="mt-2 flex items-start gap-1.5 border-t border-stone-100 pt-2 text-stone-600">
            {category === null ? (
              <ShieldQuestion aria-hidden className="mt-0.5 size-3.5 shrink-0" />
            ) : (
              <KeyRound aria-hidden className="mt-0.5 size-3.5 shrink-0" />
            )}
            <span>
              Not in this browser's vault (another session, purged, or not issued here), so it stays a token.
            </span>
          </span>
        )}
      </span>
    </span>
  );
}
