import {
  SanitizedDocumentUploadSchema,
  type SanitizedDocumentUpload,
} from "@aegis/shared";
import type { RedactionOutcome } from "../hooks/useZeroTrustScrubber.js";
import {
  DocumentAcceptedSchema,
  IngestionJobStatusSchema,
  ProtocolError,
  type DocumentAccepted,
  type IngestionJobStatus,
} from "./chat-protocol.js";
import type { WireClient } from "./wire-client.js";

export const DOCUMENTS_PATH = "/api/v1/documents";

export interface UploadInput {
  documentId: string;
  /** Must already be scrubbed. */
  fileName: string;
  outcome: RedactionOutcome;
  uploadedAt: Date;
}

/** Decimal places kept for detector confidence on the wire. */
export const CONFIDENCE_DECIMALS = 4;

/**
 * NER confidences are float32-derived (`0.9970999956130981`); a run of 13-16
 * fractional digits matches the shared guard's CREDIT_CARD pattern, so the
 * browser (and the API) would reject the upload as raw PII. Four decimals
 * is all the precision a confidence needs.
 */
export function roundConfidence(confidence: number): number {
  const factor = 10 ** CONFIDENCE_DECIMALS;
  return Math.round(confidence * factor) / factor;
}

/**
 * Builds the Day 6 upload body from a redaction outcome. Only the redacted
 * text and `{ token, category, confidence }` references are included; the
 * schema is the shared one the API validates against.
 */
export function buildUploadPayload(input: UploadInput): SanitizedDocumentUpload {
  return SanitizedDocumentUploadSchema.parse({
    documentId: input.documentId,
    fileName: input.fileName,
    mimeType: "text/plain",
    sanitizedContent: input.outcome.redactedText,
    entities: input.outcome.entities.map(({ token, category, confidence }) => ({
      token,
      category,
      confidence: roundConfidence(confidence),
    })),
    uploadedAt: input.uploadedAt.toISOString(),
  });
}

export async function submitDocument(
  client: Pick<WireClient, "postJson">,
  payload: SanitizedDocumentUpload,
): Promise<DocumentAccepted> {
  const { body } = await client.postJson(DOCUMENTS_PATH, payload, "Index document");
  const parsed = DocumentAcceptedSchema.safeParse(body);
  if (!parsed.success) throw new ProtocolError("Malformed upload acknowledgement");
  return parsed.data;
}

export async function fetchJobStatus(
  client: Pick<WireClient, "getJson">,
  jobId: string,
): Promise<IngestionJobStatus> {
  const { body } = await client.getJson(
    `${DOCUMENTS_PATH}/jobs/${encodeURIComponent(jobId)}`,
    "Ingestion status",
  );
  const parsed = IngestionJobStatusSchema.safeParse(body);
  if (!parsed.success) throw new ProtocolError("Malformed job status");
  return parsed.data;
}

/**
 * Upload file names can carry PII ("reyes_daniel_ssn.txt"). The name is
 * scrubbed like content; underscores and dashes become spaces first so the
 * NER model sees words, and the extension is kept.
 */
export async function scrubFileName(
  rawName: string,
  scrub: (text: string) => Promise<RedactionOutcome>,
): Promise<string> {
  const dot = rawName.lastIndexOf(".");
  const stem = dot > 0 ? rawName.slice(0, dot) : rawName;
  const extension = dot > 0 ? rawName.slice(dot) : "";
  const outcome = await scrub(stem.replace(/[_-]+/g, " "));
  const cleaned = outcome.redactedText.trim();
  return `${cleaned.length > 0 ? cleaned : "document"}${extension}`;
}
