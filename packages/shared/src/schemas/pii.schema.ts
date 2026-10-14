import { z } from "zod";

/**
 * Entity categories produced by the browser-side NER model and regex
 * detectors. `PER` / `ORG` / `LOC` come from token classification; the rest
 * come from deterministic regex matchers.
 */
export const EntityCategoryEnum = z.enum([
  "PER",
  "ORG",
  "LOC",
  "SSN",
  "MRN",
  "IBAN",
  "EMAIL",
  "PHONE",
  "CREDIT_CARD",
]);

export type EntityCategory = z.infer<typeof EntityCategoryEnum>;

/**
 * Deterministic placeholder tokens look like `[PER_89A1]`: a category from
 * `EntityCategoryEnum` followed by a 4-hex-digit HMAC-derived suffix.
 */
export const PlaceholderTokenRegex =
  /^\[(PER|ORG|LOC|SSN|MRN|IBAN|EMAIL|PHONE|CREDIT_CARD)_[0-9A-F]{4}\]$/;

/**
 * A redacted entity record as held in the encrypted browser vault
 * (see apps/web/src/lib/vault.ts, Day 3). `originalValue` never leaves the
 * browser and must never be sent to apps/api.
 */
export const RedactedEntitySchema = z.object({
  token: z.string().regex(PlaceholderTokenRegex),
  category: EntityCategoryEnum,
  originalValue: z.string().min(1),
  confidence: z.number().min(0).max(1),
});

export type RedactedEntity = z.infer<typeof RedactedEntitySchema>;
