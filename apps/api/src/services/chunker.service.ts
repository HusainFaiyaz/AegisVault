/**
 * Semantic chunker for sanitized Markdown / plain-text documents.
 *
 * Splits on Markdown headings first so every chunk belongs to exactly one
 * section, then packs paragraphs (and, for oversized paragraphs, sentences)
 * up to a character budget. Placeholder tokens like `[PER_89A1]` are atomic:
 * no split point ever falls inside one, so every token survives chunking
 * byte-for-byte and can be re-hydrated in the browser later.
 */

export interface ChunkerOptions {
  /** Soft upper bound on chunk length in characters. */
  maxChars?: number;
  /** Trailing chunks shorter than this are merged into their predecessor. */
  minChars?: number;
  /** Section title used for text that appears before any heading. */
  fallbackTitle?: string;
}

export interface SanitizedChunk {
  chunkIndex: number;
  /** Heading path, e.g. `Discharge Summary > Medications`. */
  sectionTitle: string;
  sanitizedContent: string;
  /** Distinct placeholder tokens present in this chunk, in first-seen order. */
  placeholderTokens: string[];
}

export const DEFAULT_MAX_CHUNK_CHARS = 1_200;
export const DEFAULT_MIN_CHUNK_CHARS = 200;

const HEADING_PATTERN = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const PLACEHOLDER_PATTERN =
  /\[(?:PER|ORG|LOC|SSN|MRN|IBAN|EMAIL|PHONE|CREDIT_CARD)_[0-9A-F]{4}\]/g;
/** Sentence end: terminal punctuation (optionally closed by a quote/paren) then whitespace. */
const SENTENCE_BOUNDARY = /(?<=[.!?]["')\]]?)\s+(?=\S)/g;

interface Section {
  title: string;
  body: string;
}

function splitSections(text: string, fallbackTitle: string): Section[] {
  const sections: Section[] = [];
  const headingPath: string[] = [];
  let title = fallbackTitle;
  let lines: string[] = [];
  let inFence = false;

  const flush = (): void => {
    const body = lines.join("\n").trim();
    if (body.length > 0) {
      sections.push({ title, body });
    }
    lines = [];
  };

  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
    }
    const heading = inFence ? null : HEADING_PATTERN.exec(line);
    if (heading?.[1] && heading[2]) {
      flush();
      const level = heading[1].length;
      headingPath.length = Math.min(headingPath.length, level - 1);
      headingPath[level - 1] = heading[2].trim();
      title = headingPath.filter((part) => part.length > 0).join(" > ");
      continue;
    }
    lines.push(line);
  }
  flush();
  return sections;
}

/** Character ranges occupied by placeholder tokens in `text`. */
function tokenRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const match of text.matchAll(PLACEHOLDER_PATTERN)) {
    ranges.push([match.index, match.index + match[0].length]);
  }
  return ranges;
}

function insideToken(position: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([start, end]) => position > start && position < end);
}

/**
 * Last-resort split for a single run of text longer than `maxChars` with no
 * sentence boundary: cut at the last whitespace before the budget, moving
 * the cut left of any token it would land inside.
 */
function hardSplit(text: string, maxChars: number): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    const ranges = tokenRanges(rest);
    let cut = rest.lastIndexOf(" ", maxChars);
    if (cut <= 0) {
      cut = maxChars;
    }
    for (const [start, end] of ranges) {
      if (cut > start && cut < end) {
        cut = start > 0 ? start : end;
      }
    }
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest.length > 0) {
    pieces.push(rest);
  }
  return pieces.filter((piece) => piece.length > 0);
}

function splitSentences(paragraph: string, maxChars: number): string[] {
  const ranges = tokenRanges(paragraph);
  const sentences: string[] = [];
  let start = 0;
  for (const match of paragraph.matchAll(SENTENCE_BOUNDARY)) {
    if (insideToken(match.index, ranges)) {
      continue;
    }
    sentences.push(paragraph.slice(start, match.index));
    start = match.index + match[0].length;
  }
  sentences.push(paragraph.slice(start));
  return sentences.flatMap((sentence) =>
    sentence.length > maxChars ? hardSplit(sentence, maxChars) : [sentence],
  );
}

/** Packs units greedily into pieces of at most `maxChars`, joined by `separator`. */
function pack(units: string[], maxChars: number, separator: string): string[] {
  const pieces: string[] = [];
  let current = "";
  for (const unit of units) {
    const candidate = current.length === 0 ? unit : `${current}${separator}${unit}`;
    if (candidate.length <= maxChars || current.length === 0) {
      current = candidate;
    } else {
      pieces.push(current);
      current = unit;
    }
  }
  if (current.length > 0) {
    pieces.push(current);
  }
  return pieces;
}

function chunkSection(body: string, maxChars: number, minChars: number): string[] {
  const paragraphs = body
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);

  const units = paragraphs.flatMap((paragraph) =>
    paragraph.length > maxChars
      ? pack(splitSentences(paragraph, maxChars), maxChars, " ")
      : [paragraph],
  );
  const pieces = pack(units, maxChars, "\n\n");

  const last = pieces.at(-1);
  const previous = pieces.at(-2);
  if (
    last !== undefined &&
    previous !== undefined &&
    last.length < minChars &&
    previous.length + last.length + 2 <= maxChars * 1.25
  ) {
    pieces.splice(-2, 2, `${previous}\n\n${last}`);
  }
  return pieces;
}

export function extractPlaceholderTokens(text: string): string[] {
  return [...new Set(text.match(PLACEHOLDER_PATTERN) ?? [])];
}

export function chunkSanitizedDocument(
  sanitizedContent: string,
  options: ChunkerOptions = {},
): SanitizedChunk[] {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHUNK_CHARS;
  const minChars = Math.min(options.minChars ?? DEFAULT_MIN_CHUNK_CHARS, maxChars);
  const fallbackTitle = options.fallbackTitle?.trim() || "Document";

  const chunks: SanitizedChunk[] = [];
  for (const section of splitSections(sanitizedContent, fallbackTitle)) {
    for (const piece of chunkSection(section.body, maxChars, minChars)) {
      chunks.push({
        chunkIndex: chunks.length,
        sectionTitle: section.title,
        sanitizedContent: piece,
        placeholderTokens: extractPlaceholderTokens(piece),
      });
    }
  }
  return chunks;
}
