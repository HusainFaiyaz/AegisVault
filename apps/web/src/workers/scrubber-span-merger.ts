import {
  detectRawPiiLeakage,
  type EntityCategory,
  type RedactedEntity,
} from "@aegis/shared";
import { generateDeterministicToken } from "../lib/pseudonymizer.js";

/**
 * A detected PII span over the source text, using half-open `[start, end)`
 * UTF-16 offsets (the same indexing as `String.prototype.slice`).
 */
export interface DetectedSpan {
  start: number;
  end: number;
  category: EntityCategory;
  confidence: number;
  source: "ner" | "regex";
}

/**
 * One token as emitted by the Transformers.js v3 `token-classification`
 * pipeline. v3 does not report character offsets, so `start`/`end` are
 * optional and recovered by aligning `word` back onto the source text.
 */
export interface NerTokenPrediction {
  word: string;
  entity: string;
  score: number;
  start?: number;
  end?: number;
}

export interface ScrubResult {
  redactedText: string;
  /** Unique entities (one per token). `originalValue` must stay in-browser. */
  entities: RedactedEntity[];
}

const NER_CATEGORIES: ReadonlySet<string> = new Set(["PER", "ORG", "LOC"]);

/**
 * Higher wins when overlapping spans compete for the same characters.
 * Deterministic structured identifiers beat statistical NER guesses, and
 * among regex categories the most specific format wins (an SSN-shaped
 * number is never relabelled as a phone number).
 */
const CATEGORY_PRIORITY: Readonly<Record<EntityCategory, number>> = {
  SSN: 90,
  MRN: 85,
  IBAN: 80,
  EMAIL: 75,
  CREDIT_CARD: 70,
  PHONE: 65,
  PER: 30,
  ORG: 20,
  LOC: 10,
};

/** Default floor below which NER predictions are discarded. */
export const DEFAULT_NER_MIN_SCORE = 0.6;

/**
 * Deterministic regex detection. Reuses the exact patterns of the shared
 * server-side ingress guard, so anything the API would reject with
 * `ZERO_TRUST_VIOLATION` is redacted in the browser first.
 */
export function detectRegexSpans(text: string): DetectedSpan[] {
  return detectRawPiiLeakage(text).map((finding) => ({
    start: finding.index,
    end: finding.index + finding.match.length,
    category: finding.category,
    confidence: 1,
    source: "regex",
  }));
}

function splitBioLabel(
  entity: string,
): { prefix: "B" | "I"; category: string } | null {
  const match = /^([BI])-(.+)$/.exec(entity);
  if (!match || match[1] === undefined || match[2] === undefined) {
    return null;
  }
  return { prefix: match[1] === "B" ? "B" : "I", category: match[2] };
}

/**
 * Converts raw BIO-tagged WordPiece predictions into character-level
 * `PER` / `ORG` / `LOC` spans.
 *
 * Tokens are aligned onto `text` sequentially with a moving cursor, so pass
 * the pipeline output with `ignore_labels: []` (every token, including `O`)
 * for the most robust alignment. `##` sub-word pieces continue the previous
 * entity; `MISC` and low-confidence predictions are dropped. Span confidence
 * is the minimum token score in the span.
 */
export function aggregateNerTokens(
  text: string,
  tokens: readonly NerTokenPrediction[],
  minScore: number = DEFAULT_NER_MIN_SCORE,
): DetectedSpan[] {
  const spans: DetectedSpan[] = [];
  let current: DetectedSpan | null = null;
  let cursor = 0;

  const flush = (): void => {
    if (current !== null) {
      spans.push(current);
      current = null;
    }
  };

  for (const token of tokens) {
    const isSubword = token.word.startsWith("##");
    const piece = isSubword ? token.word.slice(2) : token.word;
    if (piece.length === 0 || piece === "[UNK]") {
      continue;
    }

    let start: number;
    let end: number;
    if (token.start !== undefined && token.end !== undefined) {
      start = token.start;
      end = token.end;
    } else {
      const found = text.indexOf(piece, cursor);
      if (found === -1) {
        continue;
      }
      start = found;
      end = found + piece.length;
    }
    cursor = end;

    const bio = splitBioLabel(token.entity);
    const isEntity =
      bio !== null &&
      NER_CATEGORIES.has(bio.category) &&
      token.score >= minScore;

    if (!isEntity || bio === null) {
      // A low-confidence or `O` sub-word still belongs to the word it
      // continues; keep it inside the open span rather than splitting a name.
      if (isSubword && current !== null && start === current.end) {
        current.end = end;
        continue;
      }
      flush();
      continue;
    }

    const category = bio.category as EntityCategory;
    let continues = false;
    if (current !== null && current.category === category) {
      continues = isSubword
        ? start === current.end
        : bio.prefix === "I" && /^\s*$/.test(text.slice(current.end, start));
    }

    if (current !== null && continues) {
      current.end = end;
      current.confidence = Math.min(current.confidence, token.score);
    } else {
      flush();
      current = {
        start,
        end,
        category,
        confidence: token.score,
        source: "ner",
      };
    }
  }

  flush();
  return spans;
}

function outranks(a: DetectedSpan, b: DetectedSpan): boolean {
  const priorityDelta =
    CATEGORY_PRIORITY[a.category] - CATEGORY_PRIORITY[b.category];
  if (priorityDelta !== 0) return priorityDelta > 0;
  const lengthDelta = a.end - a.start - (b.end - b.start);
  if (lengthDelta !== 0) return lengthDelta > 0;
  if (a.confidence !== b.confidence) return a.confidence > b.confidence;
  return a.start < b.start;
}

/**
 * Resolves overlapping NER and regex spans into a sorted, non-overlapping
 * list. Transitively overlapping spans collapse into one span that covers
 * their union (never leaking a partially-covered fragment), labelled with
 * the category of the highest-ranked member by priority, then length, then
 * confidence.
 */
export function mergeSpans(spans: readonly DetectedSpan[]): DetectedSpan[] {
  const sorted = spans
    .filter((span) => span.end > span.start)
    .slice()
    .sort((a, b) => a.start - b.start || b.end - a.end);

  const merged: DetectedSpan[] = [];
  let cluster: DetectedSpan | null = null;
  let winner: DetectedSpan | null = null;

  for (const span of sorted) {
    if (cluster !== null && winner !== null && span.start < cluster.end) {
      cluster.end = Math.max(cluster.end, span.end);
      if (outranks(span, winner)) {
        winner = span;
      }
      continue;
    }
    if (cluster !== null && winner !== null) {
      merged.push({ ...winner, start: cluster.start, end: cluster.end });
    }
    cluster = { ...span };
    winner = span;
  }
  if (cluster !== null && winner !== null) {
    merged.push({ ...winner, start: cluster.start, end: cluster.end });
  }

  return merged;
}

/**
 * Replaces each merged span with its deterministic `[CATEGORY_HEX4]` token
 * from the session HMAC key, returning the redacted text plus the unique
 * token → original-value entities destined for the encrypted local vault.
 */
export async function applyRedactions(
  text: string,
  spans: readonly DetectedSpan[],
  sessionKey: CryptoKey,
): Promise<ScrubResult> {
  const ordered = mergeSpans(spans);
  const tokens = await Promise.all(
    ordered.map((span) =>
      generateDeterministicToken(
        sessionKey,
        span.category,
        text.slice(span.start, span.end),
      ),
    ),
  );

  const parts: string[] = [];
  const entitiesByToken = new Map<string, RedactedEntity>();
  let cursor = 0;

  ordered.forEach((span, i) => {
    const token = tokens[i];
    if (token === undefined) return;
    const originalValue = text.slice(span.start, span.end);
    parts.push(text.slice(cursor, span.start), token);
    cursor = span.end;

    const existing = entitiesByToken.get(token);
    if (existing === undefined || span.confidence > existing.confidence) {
      entitiesByToken.set(token, {
        token,
        category: span.category,
        originalValue,
        confidence: span.confidence,
      });
    }
  });
  parts.push(text.slice(cursor));

  return {
    redactedText: parts.join(""),
    entities: [...entitiesByToken.values()],
  };
}

/**
 * Full hybrid pass: regex + NER spans → overlap resolution → deterministic
 * tokens. As a final fail-closed check the redacted output is re-scanned
 * with the shared leakage guard and throws if anything raw survived.
 */
export async function scrubWithSpans(
  text: string,
  nerSpans: readonly DetectedSpan[],
  sessionKey: CryptoKey,
): Promise<ScrubResult> {
  const result = await applyRedactions(
    text,
    [...detectRegexSpans(text), ...nerSpans],
    sessionKey,
  );
  const residual = detectRawPiiLeakage(result.redactedText);
  if (residual.length > 0) {
    throw new Error(
      `ZERO_TRUST_VIOLATION: ${residual.length} raw PII span(s) survived redaction`,
    );
  }
  return result;
}

/**
 * Splits long input into whitespace-aligned chunks small enough for the
 * 512-token BERT context window. Returns each chunk with its offset in the
 * original text so NER spans can be shifted back into place.
 */
export function chunkForNer(
  text: string,
  maxChars = 1200,
): Array<{ offset: number; text: string }> {
  const chunks: Array<{ offset: number; text: string }> = [];
  let offset = 0;
  while (offset < text.length) {
    let end = Math.min(offset + maxChars, text.length);
    if (end < text.length) {
      const breakAt = text.lastIndexOf(" ", end);
      if (breakAt > offset) end = breakAt;
    }
    chunks.push({ offset, text: text.slice(offset, end) });
    offset = end;
  }
  return chunks;
}
