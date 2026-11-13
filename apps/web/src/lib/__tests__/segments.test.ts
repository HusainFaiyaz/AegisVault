import { describe, expect, it } from "vitest";
import { categoryOfToken, segmentText, toRenderSegments } from "../segments.js";
import type { StreamSegment } from "../stream-rehydrator.js";

const lookup = new Map([["[PER_89A1]", "Daniel Reyes"]]);

describe("segmentText", () => {
  it("splits text around tokens and resolves known ones", () => {
    expect(segmentText("Patient [PER_89A1], MRN [MRN_3F90].", lookup)).toEqual([
      { type: "text", content: "Patient " },
      { type: "entity", content: "[PER_89A1]", token: "[PER_89A1]", originalValue: "Daniel Reyes" },
      { type: "text", content: ", MRN " },
      { type: "entity", content: "[MRN_3F90]", token: "[MRN_3F90]", originalValue: undefined },
      { type: "text", content: "." },
    ]);
  });

  it("leaves malformed tokens and citation markers as text", () => {
    expect(segmentText("[PER_89a1] [CIT-01] [FOO_1234]", lookup)).toEqual([
      { type: "text", content: "[PER_89a1] [CIT-01] [FOO_1234]" },
    ]);
  });

  it("is safe to call repeatedly (global regex state is reset)", () => {
    expect(segmentText("[PER_89A1]", lookup)).toHaveLength(1);
    expect(segmentText("[PER_89A1]", lookup)).toHaveLength(1);
  });
});

describe("toRenderSegments", () => {
  it("merges streamed text fragments before finding citation markers split across them", () => {
    const streamed: StreamSegment[] = [
      { type: "text", content: "Stable [CI" },
      { type: "text", content: "T-0" },
      { type: "text", content: "2]. Seen by " },
      { type: "entity", content: "[PER_89A1]", token: "[PER_89A1]", originalValue: "Daniel Reyes" },
      { type: "text", content: " [CIT-01]" },
    ];
    expect(toRenderSegments(streamed)).toEqual([
      { type: "text", content: "Stable " },
      { type: "citation", marker: "[CIT-02]" },
      { type: "text", content: ". Seen by " },
      { type: "entity", token: "[PER_89A1]", originalValue: "Daniel Reyes" },
      { type: "text", content: " " },
      { type: "citation", marker: "[CIT-01]" },
    ]);
  });
});

describe("categoryOfToken", () => {
  it("extracts the category, including CREDIT_CARD's underscore", () => {
    expect(categoryOfToken("[PER_89A1]")).toBe("PER");
    expect(categoryOfToken("[CREDIT_CARD_0F1E]")).toBe("CREDIT_CARD");
    expect(categoryOfToken("[CIT-01]")).toBeNull();
  });
});
