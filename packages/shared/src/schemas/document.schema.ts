import { z } from "zod";

import { EntityCategoryEnum, PlaceholderTokenRegex } from "./pii.schema.js";

/**
 * Reference to a redacted entity as it travels over the wire: token and
 * category only, never `originalValue`.
 */
export const SanitizedEntityRefSchema = z.object({
  token: z.string().regex(PlaceholderTokenRegex),
  category: EntityCategoryEnum,
  confidence: z.number().min(0).max(1),
});

export type SanitizedEntityRef = z.infer<typeof SanitizedEntityRefSchema>;

/**
 * Payload posted to `POST /api/v1/documents` (Day 6). `sanitizedContent`
 * must contain only placeholder tokens for any detected PII.
 */
export const SanitizedDocumentUploadSchema = z.object({
  documentId: z.string().uuid(),
  fileName: z.string().min(1),
  mimeType: z.string().min(1),
  sanitizedContent: z.string().min(1),
  entities: z.array(SanitizedEntityRefSchema),
  uploadedAt: z.string().datetime(),
});

export type SanitizedDocumentUpload = z.infer<
  typeof SanitizedDocumentUploadSchema
>;

/**
 * A single retrieved, reranked chunk returned alongside the LLM stream
 * (Day 7 / Day 8) so the client can ground and re-hydrate citations.
 */
export const CitationChunkSchema = z.object({
  chunkId: z.string().uuid(),
  documentId: z.string().uuid(),
  sectionTitle: z.string().min(1),
  sanitizedContent: z.string().min(1),
  citationMarker: z.string().regex(/^\[CIT-\d{2}\]$/),
  score: z.number().min(0).max(1),
});

export type CitationChunk = z.infer<typeof CitationChunkSchema>;
