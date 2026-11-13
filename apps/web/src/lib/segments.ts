import { PlaceholderTokenRegex, type EntityCategory } from "@aegis/shared";
import type { EntityLookupMap, StreamSegment } from "./stream-rehydrator.js";

/**
 * Rendering helpers shared by the X-Ray view and the copilot transcript.
 * Streaming text goes through `createRehydrationTransformStream`; complete
 * strings (a finished redaction, a stored chat turn) are segmented here
 * synchronously with the same token grammar.
 */

const TOKEN_SCAN = new RegExp(
  PlaceholderTokenRegex.source.replace(/^\^/, "").replace(/\$$/, ""),
  "g",
);
const CITATION_SCAN = /\[CIT-\d{2}\]/g;

export type RenderSegment =
  | { type: "text"; content: string }
  | { type: "entity"; token: string; originalValue: string | undefined }
  | { type: "citation"; marker: string };

/** Splits a complete string into text and placeholder-token segments. */
export function segmentText(text: string, lookup: EntityLookupMap): StreamSegment[] {
  const segments: StreamSegment[] = [];
  let cursor = 0;
  TOKEN_SCAN.lastIndex = 0;
  for (let match = TOKEN_SCAN.exec(text); match !== null; match = TOKEN_SCAN.exec(text)) {
    if (match.index > cursor) {
      segments.push({ type: "text", content: text.slice(cursor, match.index) });
    }
    const token = match[0];
    segments.push({ type: "entity", content: token, token, originalValue: lookup.get(token) });
    cursor = match.index + token.length;
  }
  if (cursor < text.length) segments.push({ type: "text", content: text.slice(cursor) });
  return segments;
}

/**
 * Converts rehydrator output into render segments: adjacent text segments
 * are merged (streams emit many small ones) and `[CIT-XX]` markers inside
 * text become citation segments. Merging first matters: a marker split
 * across two deltas is only recognisable once its halves are joined.
 */
export function toRenderSegments(segments: readonly StreamSegment[]): RenderSegment[] {
  const merged: StreamSegment[] = [];
  for (const segment of segments) {
    const last = merged.at(-1);
    if (segment.type === "text" && last?.type === "text") {
      merged[merged.length - 1] = { type: "text", content: last.content + segment.content };
    } else {
      merged.push(segment);
    }
  }

  const out: RenderSegment[] = [];
  for (const segment of merged) {
    if (segment.type === "entity") {
      out.push({
        type: "entity",
        token: segment.token ?? segment.content,
        originalValue: segment.originalValue,
      });
      continue;
    }
    let cursor = 0;
    CITATION_SCAN.lastIndex = 0;
    const text = segment.content;
    for (let match = CITATION_SCAN.exec(text); match !== null; match = CITATION_SCAN.exec(text)) {
      if (match.index > cursor) out.push({ type: "text", content: text.slice(cursor, match.index) });
      out.push({ type: "citation", marker: match[0] });
      cursor = match.index + match[0].length;
    }
    if (cursor < text.length) out.push({ type: "text", content: text.slice(cursor) });
  }
  return out;
}

/** `[PER_89A1]` -> `PER`. Returns null for anything that is not a token. */
export function categoryOfToken(token: string): EntityCategory | null {
  if (!PlaceholderTokenRegex.test(token)) return null;
  return token.slice(1, token.lastIndexOf("_")) as EntityCategory;
}
