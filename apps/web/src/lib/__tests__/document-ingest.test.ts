import { detectRawPiiLeakage, SanitizedDocumentUploadSchema } from "@aegis/shared";
import { describe, expect, it, vi } from "vitest";
import type { RedactionOutcome } from "../../hooks/useZeroTrustScrubber.js";
import { generateSessionHmacKey } from "../pseudonymizer.js";
import { REDACTION_PRESETS } from "../presets.js";
import { buildUploadPayload, roundConfidence, scrubFileName, submitDocument } from "../document-ingest.js";
import { inspectEgress } from "../wire-client.js";
import { scrubWithSpans } from "../../workers/scrubber-span-merger.js";
import { ProtocolError } from "../chat-protocol.js";

describe("presets", () => {
  it.each(REDACTION_PRESETS.map((preset) => [preset.label, preset] as const))(
    "%s exercises every regex category and is fully sanitised by the regex pass alone",
    async (_label, preset) => {
      const findings = detectRawPiiLeakage(preset.text);
      expect(new Set(findings.map((finding) => finding.category))).toEqual(
        new Set(preset.id === "hipaa-clinical" ? ["SSN", "MRN", "EMAIL", "PHONE", "CREDIT_CARD"] : ["SSN", "IBAN", "EMAIL", "PHONE", "CREDIT_CARD"]),
      );
      // No NER spans: even if the model contributed nothing, the wire copy is clean.
      const result = await scrubWithSpans(preset.text, [], await generateSessionHmacKey());
      expect(detectRawPiiLeakage(result.redactedText)).toEqual([]);
    },
  );
});

describe("buildUploadPayload", () => {
  const outcome: RedactionOutcome = {
    redactedText: "Patient [PER_89A1], MRN [MRN_3F90].",
    entities: [
      { token: "[PER_89A1]", category: "PER", confidence: 0.97 },
      { token: "[MRN_3F90]", category: "MRN", confidence: 1 },
    ],
  };

  it("builds a body the API's shared schema accepts, with no original values", () => {
    const payload = buildUploadPayload({
      documentId: "0b8f3c2e-9d61-4f07-8a55-3e2f6b1d9c40",
      fileName: "discharge.txt",
      outcome,
      uploadedAt: new Date("2026-11-13T09:30:00Z"),
    });
    expect(SanitizedDocumentUploadSchema.safeParse(payload).success).toBe(true);
    expect(payload.sanitizedContent).toBe(outcome.redactedText);
    expect(payload.entities).toEqual(outcome.entities);
    expect(JSON.stringify(payload)).not.toContain("originalValue");
  });

  it("rounds float32 NER confidences so the payload does not trip the card-number guard", () => {
    // Regression: a real bert-base-NER score, serialised with 16 fractional digits,
    // matched CREDIT_CARD and the browser blocked the upload.
    const score = Math.fround(0.9971);
    expect(inspectEgress(JSON.stringify({ confidence: score })).categories).toEqual(["CREDIT_CARD"]);

    const payload = buildUploadPayload({
      documentId: "0b8f3c2e-9d61-4f07-8a55-3e2f6b1d9c40",
      fileName: "a.txt",
      outcome: { redactedText: "[PER_89A1]", entities: [{ token: "[PER_89A1]", category: "PER", confidence: score }] },
      uploadedAt: new Date(),
    });
    expect(payload.entities[0]?.confidence).toBe(0.9971);
    expect(inspectEgress(JSON.stringify(payload))).toEqual({ clean: true, categories: [] });
    expect(roundConfidence(1)).toBe(1);
    expect(roundConfidence(0.61234999)).toBe(0.6123);
  });

  it("strips extra fields such as an originalValue smuggled onto an entity", () => {
    const smuggled = {
      ...outcome,
      entities: [{ token: "[PER_89A1]", category: "PER" as const, confidence: 0.97, originalValue: "Daniel Reyes" }],
    };
    const payload = buildUploadPayload({ documentId: "0b8f3c2e-9d61-4f07-8a55-3e2f6b1d9c40", fileName: "a.txt", outcome: smuggled, uploadedAt: new Date() });
    expect(JSON.stringify(payload)).not.toContain("Daniel");
  });
});

describe("scrubFileName", () => {
  it("scrubs the stem as words and keeps the extension", async () => {
    const scrub = vi.fn(async (text: string): Promise<RedactionOutcome> => ({
      redactedText: text.replace("daniel reyes", "[PER_89A1]"),
      entities: [],
    }));
    await expect(scrubFileName("daniel_reyes-labs.txt", scrub)).resolves.toBe("[PER_89A1] labs.txt");
    expect(scrub).toHaveBeenCalledWith("daniel reyes labs");
  });

  it("falls back to a neutral name when nothing is left", async () => {
    await expect(scrubFileName(".txt", async () => ({ redactedText: " ", entities: [] }))).resolves.toBe("document");
  });
});

describe("submitDocument", () => {
  it("validates the 202 acknowledgement", async () => {
    const ack = { jobId: "j", documentId: "d", state: "queued", statusUrl: "/s", traceId: "t" };
    await expect(submitDocument({ postJson: async () => ({ status: 202, body: ack }) }, {} as never)).resolves.toEqual(ack);
    await expect(submitDocument({ postJson: async () => ({ status: 202, body: { ok: true } }) }, {} as never)).rejects.toBeInstanceOf(ProtocolError);
  });
});
