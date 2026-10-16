import type { EntityCategory, RedactedEntity } from "@aegis/shared";

/**
 * SHA-256 digest of a single redacted entity's non-sensitive fields
 * (`token`, `category`, `confidence`). `originalValue` is never hashed into
 * this, so the digest can be exported or logged without leaking PII.
 */
export interface EntityDigest {
  token: string;
  category: EntityCategory;
  digest: string;
}

/**
 * A zero-knowledge receipt proving that local, client-side redaction
 * occurred for a set of entities in a session — without containing any raw
 * PII. Safe to export, log, or hand to the server/client as evidence.
 */
export interface CryptographicAuditProof {
  sessionId: string;
  generatedAt: string;
  entityCount: number;
  categoryBreakdown: Partial<Record<EntityCategory, number>>;
  entityDigests: EntityDigest[];
  merkleRoot: string;
}

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return bytesToHex(digest);
}

/**
 * Hashes only the non-sensitive fields of a redacted entity. `originalValue`
 * is deliberately excluded so this digest — and anything built from it —
 * can never be used to recover raw PII.
 */
export async function computeEntityDigest(
  entity: RedactedEntity,
): Promise<EntityDigest> {
  const digest = await sha256Hex(
    `${entity.token}:${entity.category}:${entity.confidence}`,
  );
  return { token: entity.token, category: entity.category, digest };
}

/**
 * Folds a list of entity digests into a single Merkle root by repeatedly
 * hashing adjacent pairs (duplicating the last node when a level is odd).
 * An empty input still yields a stable, verifiable root (the hash of the
 * empty string) rather than an unreachable sentinel value.
 */
export async function computeMerkleRoot(
  digests: readonly string[],
): Promise<string> {
  if (digests.length === 0) {
    return sha256Hex("");
  }

  let level: string[] = [...digests];
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = level[i + 1] ?? left;
      next.push(await sha256Hex(`${left}${right}`));
    }
    level = next;
  }
  return level[0] ?? "";
}

/**
 * Builds a cryptographic receipt proving that local redaction occurred for
 * `entities` in `sessionId`. The receipt contains only tokens, categories,
 * confidences, and SHA-256 digests/Merkle root derived from them — never
 * `originalValue` — so it is safe to export outside the browser.
 */
export async function generateAuditReceipt(
  sessionId: string,
  entities: readonly RedactedEntity[],
): Promise<CryptographicAuditProof> {
  const entityDigests = await Promise.all(entities.map(computeEntityDigest));
  const merkleRoot = await computeMerkleRoot(
    entityDigests.map((entityDigest) => entityDigest.digest),
  );

  const categoryBreakdown: Partial<Record<EntityCategory, number>> = {};
  for (const entity of entities) {
    categoryBreakdown[entity.category] =
      (categoryBreakdown[entity.category] ?? 0) + 1;
  }

  return {
    sessionId,
    generatedAt: new Date().toISOString(),
    entityCount: entities.length,
    categoryBreakdown,
    entityDigests,
    merkleRoot,
  };
}
