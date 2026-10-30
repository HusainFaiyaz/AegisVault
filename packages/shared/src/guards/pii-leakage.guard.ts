import type { EntityCategory } from "../schemas/pii.schema.js";

export interface PiiLeakageFinding {
  category: EntityCategory;
  match: string;
  index: number;
}

/**
 * Matches a full placeholder token, e.g. `[SSN_1A2B]`. Used to blank out
 * legitimate placeholders before scanning for raw PII, so a token's hex
 * suffix is never mistaken for part of a real identifier.
 */
const PLACEHOLDER_TOKEN_PATTERN =
  /\[(?:PER|ORG|LOC|SSN|MRN|IBAN|EMAIL|PHONE|CREDIT_CARD)_[0-9A-F]{4}\]/g;

/**
 * Matches a canonical 8-4-4-4-12 UUID. Document, chunk and job ids are UUIDs
 * and travel in every API payload; their digit runs would otherwise match
 * the PHONE or CREDIT_CARD patterns (~0.7% of random v4 UUIDs do), so they
 * are blanked out the same way placeholders are.
 */
const UUID_PATTERN =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

const RAW_PII_PATTERNS: ReadonlyArray<{
  category: EntityCategory;
  pattern: RegExp;
}> = [
  { category: "SSN", pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
  { category: "MRN", pattern: /\bMRN[-:\s]?\d{6,10}\b/gi },
  { category: "IBAN", pattern: /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g },
  { category: "CREDIT_CARD", pattern: /\b(?:\d[ -]?){13,16}\b/g },
  { category: "EMAIL", pattern: /\b[\w.+-]+@[\w-]+\.[A-Za-z]{2,}\b/g },
  {
    category: "PHONE",
    pattern: /\b(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
  },
];

/**
 * Scans `text` for raw, unredacted PII. Legitimate `[CATEGORY_HEX4]`
 * placeholders and UUIDs are blanked out first so they can never trigger a
 * false positive. Returns every raw PII match found; an empty array means the
 * text is safe to forward past the zero-trust boundary.
 */
export function detectRawPiiLeakage(text: string): PiiLeakageFinding[] {
  const blank = (m: string): string => " ".repeat(m.length);
  const sanitizedForScanning = text
    .replace(PLACEHOLDER_TOKEN_PATTERN, blank)
    .replace(UUID_PATTERN, blank);

  const findings: PiiLeakageFinding[] = [];

  for (const { category, pattern } of RAW_PII_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(sanitizedForScanning)) !== null) {
      findings.push({ category, match: match[0], index: match.index });
      if (match[0].length === 0) {
        pattern.lastIndex += 1;
      }
    }
  }

  return findings;
}

export function hasRawPiiLeakage(text: string): boolean {
  return detectRawPiiLeakage(text).length > 0;
}
