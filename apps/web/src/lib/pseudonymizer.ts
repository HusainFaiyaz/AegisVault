import type { EntityCategory } from "@aegis/shared";

/**
 * Normalizes raw entity text before hashing so that trivially different
 * representations of the same real-world value (casing, surrounding/extra
 * whitespace) always resolve to the same deterministic token.
 */
function normalizeEntityValue(rawValue: string): string {
  return rawValue.trim().toLowerCase().replace(/\s+/g, " ");
}

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Derives a non-extractable HMAC-SHA256 key for the current session. The raw
 * key material never leaves the browser and is held only in memory for the
 * lifetime of the session.
 */
export async function generateSessionHmacKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
}

/**
 * Produces a deterministic `[CATEGORY_HEX4]` placeholder token for a raw PII
 * value. The same session key + category + (normalized) raw value always
 * produces the exact same token, so repeated mentions of an entity within a
 * session are pseudonymized consistently without ever hashing or storing the
 * plaintext outside the browser.
 */
export async function generateDeterministicToken(
  sessionKey: CryptoKey,
  category: EntityCategory,
  rawValue: string,
): Promise<string> {
  const normalized = normalizeEntityValue(rawValue);
  const data = new TextEncoder().encode(normalized);
  const signature = await crypto.subtle.sign("HMAC", sessionKey, data);
  const suffix = bytesToHex(signature).toUpperCase().slice(0, 4);
  return `[${category}_${suffix}]`;
}
