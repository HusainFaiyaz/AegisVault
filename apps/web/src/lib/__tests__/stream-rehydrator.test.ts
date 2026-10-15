import { describe, expect, it } from "vitest";

import {
  createRehydrationTransformStream,
  type EntityLookupMap,
  type StreamSegment,
} from "../stream-rehydrator.js";

async function collectSegments(
  chunks: readonly string[],
  lookup: EntityLookupMap,
): Promise<StreamSegment[]> {
  const source = new ReadableStream<string>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });

  const rehydrated = source.pipeThrough(
    createRehydrationTransformStream(lookup),
  );

  const segments: StreamSegment[] = [];
  const reader = rehydrated.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    segments.push(value);
  }
  return segments;
}

describe("createRehydrationTransformStream", () => {
  it("re-hydrates a placeholder token split arbitrarily across SSE chunk boundaries", async () => {
    const lookup: EntityLookupMap = new Map([["[PER_89A1]", "John Doe"]]);

    const segments = await collectSegments(
      ["Patient ", "[PER", "_89", "A1]", " is stable"],
      lookup,
    );

    expect(segments).toEqual([
      { type: "text", content: "Patient " },
      {
        type: "entity",
        content: "[PER_89A1]",
        token: "[PER_89A1]",
        originalValue: "John Doe",
      },
      { type: "text", content: " is stable" },
    ]);
  });

  it("resolves multiple distinct entity tokens within a single chunk", async () => {
    const lookup: EntityLookupMap = new Map([
      ["[PER_1A2B]", "Maria Alvarez"],
      ["[ORG_FACE]", "Acme Health"],
    ]);

    const segments = await collectSegments(
      ["[PER_1A2B] works with [ORG_FACE] today"],
      lookup,
    );

    expect(segments).toEqual([
      {
        type: "entity",
        content: "[PER_1A2B]",
        token: "[PER_1A2B]",
        originalValue: "Maria Alvarez",
      },
      { type: "text", content: " works with " },
      {
        type: "entity",
        content: "[ORG_FACE]",
        token: "[ORG_FACE]",
        originalValue: "Acme Health",
      },
      { type: "text", content: " today" },
    ]);
  });

  it("emits an entity segment with an undefined originalValue when the token is not in the lookup map", async () => {
    const segments = await collectSegments(["Ref [MRN_3F90] on file"], new Map());

    expect(segments).toEqual([
      { type: "text", content: "Ref " },
      {
        type: "entity",
        content: "[MRN_3F90]",
        token: "[MRN_3F90]",
        originalValue: undefined,
      },
      { type: "text", content: " on file" },
    ]);
  });

  it("passes bracketed text that is not a valid placeholder token through as plain text", async () => {
    const segments = await collectSegments(
      ["Contact [not-a-token] please"],
      new Map(),
    );

    expect(segments).toEqual([
      { type: "text", content: "Contact [not-a-token] please" },
    ]);
  });

  it("flushes a never-closed bracket as plain text when the stream ends", async () => {
    const segments = await collectSegments(["Unexpected end [PER_12"], new Map());

    expect(segments).toEqual([
      { type: "text", content: "Unexpected end " },
      { type: "text", content: "[PER_12" },
    ]);
  });

  it("produces the exact same token text for the same entity repeated across chunks", async () => {
    const lookup: EntityLookupMap = new Map([["[SSN_1A2B]", "123-45-6789"]]);

    const segments = await collectSegments(
      ["[SSN_1A2B] and again [SSN_1A2B]"],
      lookup,
    );

    const entityTokens = segments
      .filter((segment) => segment.type === "entity")
      .map((segment) => segment.token);

    expect(entityTokens).toEqual(["[SSN_1A2B]", "[SSN_1A2B]"]);
  });
});
