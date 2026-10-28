import { describe, expect, it, beforeAll } from "vitest";
import { detectRawPiiLeakage, PlaceholderTokenRegex } from "@aegis/shared";
import { generateSessionHmacKey } from "../../lib/pseudonymizer.js";
import {
  aggregateNerTokens,
  applyRedactions,
  chunkForNer,
  detectRegexSpans,
  mergeSpans,
  scrubWithSpans,
  type DetectedSpan,
  type NerTokenPrediction,
} from "../scrubber-span-merger.js";

function span(
  start: number,
  end: number,
  category: DetectedSpan["category"],
  confidence = 1,
  source: DetectedSpan["source"] = "regex",
): DetectedSpan {
  return { start, end, category, confidence, source };
}

function tok(word: string, entity: string, score = 0.99): NerTokenPrediction {
  return { word, entity, score };
}

let sessionKey: CryptoKey;

beforeAll(async () => {
  sessionKey = await generateSessionHmacKey();
});

describe("detectRegexSpans", () => {
  it("finds structured identifiers with exact offsets", () => {
    const text = "SSN 123-45-6789, mail jane.doe@example.com, MRN:00482913";
    const spans = detectRegexSpans(text);
    const byCategory = new Map(
      spans.map((s) => [s.category, text.slice(s.start, s.end)]),
    );
    expect(byCategory.get("SSN")).toBe("123-45-6789");
    expect(byCategory.get("EMAIL")).toBe("jane.doe@example.com");
    expect(byCategory.get("MRN")).toBe("MRN:00482913");
    expect(spans.every((s) => s.source === "regex" && s.confidence === 1)).toBe(
      true,
    );
  });
});

describe("aggregateNerTokens", () => {
  it("merges B-/I- tags and ## sub-words into character spans", () => {
    const text = "Patient Johnathan Okafor visited Mercy General in Boston.";
    const tokens = [
      tok("Patient", "O"),
      tok("John", "B-PER"),
      tok("##athan", "I-PER"),
      tok("Ok", "I-PER"),
      tok("##af", "I-PER"),
      tok("##or", "I-PER"),
      tok("visited", "O"),
      tok("Mercy", "B-ORG"),
      tok("General", "I-ORG"),
      tok("in", "O"),
      tok("Boston", "B-LOC"),
      tok(".", "O"),
    ];
    const spans = aggregateNerTokens(text, tokens);
    expect(spans.map((s) => [s.category, text.slice(s.start, s.end)])).toEqual([
      ["PER", "Johnathan Okafor"],
      ["ORG", "Mercy General"],
      ["LOC", "Boston"],
    ]);
    expect(spans.every((s) => s.source === "ner")).toBe(true);
  });

  it("drops MISC and low-confidence predictions", () => {
    const text = "Ana flew Lufthansa to Paris";
    const spans = aggregateNerTokens(text, [
      tok("Ana", "B-PER", 0.4),
      tok("flew", "O"),
      tok("Lufthansa", "B-MISC"),
      tok("to", "O"),
      tok("Paris", "B-LOC", 0.93),
    ]);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.category).toBe("LOC");
    expect(spans[0]?.confidence).toBeCloseTo(0.93);
  });

  it("splits adjacent entities on a fresh B- tag", () => {
    const text = "Smith Jones";
    const spans = aggregateNerTokens(text, [
      tok("Smith", "B-PER"),
      tok("Jones", "B-PER"),
    ]);
    expect(spans.map((s) => text.slice(s.start, s.end))).toEqual([
      "Smith",
      "Jones",
    ]);
  });

  it("aligns sequentially so repeated words map to the right occurrence", () => {
    const text = "Paris met Paris";
    const spans = aggregateNerTokens(text, [
      tok("Paris", "O"),
      tok("met", "O"),
      tok("Paris", "B-PER"),
    ]);
    expect(spans).toEqual([
      { start: 10, end: 15, category: "PER", confidence: 0.99, source: "ner" },
    ]);
  });

  it("keeps a low-confidence trailing sub-word inside the open span", () => {
    const text = "Dr Nakamura";
    const spans = aggregateNerTokens(text, [
      tok("Dr", "O"),
      tok("Naka", "B-PER"),
      tok("##mura", "I-PER", 0.2),
    ]);
    expect(spans.map((s) => text.slice(s.start, s.end))).toEqual(["Nakamura"]);
  });
});

describe("mergeSpans", () => {
  it("lets a regex category outrank an overlapping NER guess", () => {
    const merged = mergeSpans([
      span(0, 11, "PER", 0.95, "ner"),
      span(0, 11, "SSN"),
    ]);
    expect(merged).toEqual([span(0, 11, "SSN")]);
  });

  it("prefers the longer span within the same priority", () => {
    const merged = mergeSpans([
      span(5, 10, "PER", 0.99, "ner"),
      span(0, 10, "PER", 0.8, "ner"),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ start: 0, end: 10, confidence: 0.8 });
  });

  it("covers the union of partial overlaps so no fragment leaks", () => {
    const merged = mergeSpans([
      span(0, 12, "SSN"),
      span(8, 20, "PHONE"),
      span(18, 25, "LOC", 0.9, "ner"),
    ]);
    expect(merged).toEqual([span(0, 25, "SSN")]);
  });

  it("returns non-overlapping spans sorted by start and drops empty ones", () => {
    const merged = mergeSpans([
      span(20, 25, "LOC", 0.9, "ner"),
      span(3, 3, "PER", 0.9, "ner"),
      span(0, 5, "PER", 0.9, "ner"),
    ]);
    expect(merged.map((s) => [s.start, s.end])).toEqual([
      [0, 5],
      [20, 25],
    ]);
  });
});

describe("applyRedactions", () => {
  it("replaces spans with deterministic tokens and dedupes entities", async () => {
    const text = "Call Priya Raman. Priya Raman owes 2 visits.";
    const spans = [
      span(5, 16, "PER", 0.97, "ner"),
      span(18, 29, "PER", 0.91, "ner"),
    ];
    const { redactedText, entities } = await applyRedactions(
      text,
      spans,
      sessionKey,
    );

    expect(redactedText).not.toContain("Priya");
    expect(entities).toHaveLength(1);
    const [entity] = entities;
    expect(entity?.token).toMatch(PlaceholderTokenRegex);
    expect(entity?.originalValue).toBe("Priya Raman");
    expect(entity?.confidence).toBe(0.97);
    expect(redactedText).toBe(
      `Call ${entity?.token}. ${entity?.token} owes 2 visits.`,
    );
  });
});

describe("scrubWithSpans", () => {
  it("produces output that passes the shared zero-trust leakage guard", async () => {
    const text =
      "Maria Lopez (SSN 078-05-1120, MRN-4471209) can be reached at " +
      "maria.lopez@clinic.org or 415-555-0132. IBAN DE89370400440532013000.";
    const nerSpans = aggregateNerTokens(text, [
      tok("Maria", "B-PER"),
      tok("Lopez", "I-PER"),
    ]);

    const { redactedText, entities } = await scrubWithSpans(
      text,
      nerSpans,
      sessionKey,
    );

    expect(detectRawPiiLeakage(redactedText)).toEqual([]);
    for (const entity of entities) {
      expect(redactedText).not.toContain(entity.originalValue);
      expect(redactedText).toContain(entity.token);
    }
    expect(new Set(entities.map((e) => e.category))).toEqual(
      new Set(["PER", "SSN", "MRN", "EMAIL", "PHONE", "IBAN"]),
    );
  });

  it("is deterministic across calls within a session", async () => {
    const text = "Contact ops@aegis.dev";
    const a = await scrubWithSpans(text, [], sessionKey);
    const b = await scrubWithSpans(text, [], sessionKey);
    expect(a.redactedText).toBe(b.redactedText);
  });
});

describe("chunkForNer", () => {
  it("splits on whitespace and preserves offsets", () => {
    const text = "alpha beta gamma delta epsilon";
    const chunks = chunkForNer(text, 12);
    expect(chunks.map((c) => c.text).join("")).toBe(text);
    for (const chunk of chunks) {
      expect(text.slice(chunk.offset, chunk.offset + chunk.text.length)).toBe(
        chunk.text,
      );
      expect(chunk.text.length).toBeLessThanOrEqual(12);
    }
    expect(chunks.length).toBeGreaterThan(1);
  });
});
