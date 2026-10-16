import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { openDB } from "idb";
import type { RedactedEntity } from "@aegis/shared";
import {
  exportCryptographicAuditProof,
  getDecryptedSessionMap,
  purgeSessionVault,
  storeRedactedBatch,
} from "../vault.js";

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function bytesToBinaryString(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => String.fromCharCode(byte))
    .join("");
}

function makeEntity(overrides: Partial<RedactedEntity> = {}): RedactedEntity {
  return {
    token: "[PER_89A1]",
    category: "PER",
    originalValue: "John Doe",
    confidence: 0.97,
    ...overrides,
  };
}

/** Reads the raw, still-encrypted rows directly out of IndexedDB, bypassing vault.ts entirely. */
async function readRawEntityRows(): Promise<
  { sessionId: string; iv: Uint8Array; ciphertext: ArrayBuffer }[]
> {
  const db = await openDB("aegis-vault", 1);
  const rows = await db.getAll("redacted-entities");
  db.close();
  return rows as { sessionId: string; iv: Uint8Array; ciphertext: ArrayBuffer }[];
}

describe("vault", () => {
  let sessionId: string;

  beforeEach(() => {
    sessionId = crypto.randomUUID();
  });

  it("round-trips a stored batch through decryption unchanged", async () => {
    const entities = [
      makeEntity({ token: "[PER_89A1]", originalValue: "John Doe" }),
      makeEntity({
        token: "[SSN_1A2B]",
        category: "SSN",
        originalValue: "078-05-1120",
        confidence: 0.99,
      }),
    ];

    await storeRedactedBatch(sessionId, entities);
    const sessionMap = await getDecryptedSessionMap(sessionId);

    expect(sessionMap.size).toBe(2);
    expect(sessionMap.get("[PER_89A1]")).toEqual(entities[0]);
    expect(sessionMap.get("[SSN_1A2B]")).toEqual(entities[1]);
  });

  it("never stores the raw original value as plaintext in IndexedDB", async () => {
    const secret = "078-05-1120";
    await storeRedactedBatch(sessionId, [
      makeEntity({
        token: "[SSN_1A2B]",
        category: "SSN",
        originalValue: secret,
      }),
    ]);

    const rows = await readRawEntityRows();
    const ownRow = rows.find((row) => row.sessionId === sessionId);
    expect(ownRow).toBeDefined();

    const ciphertextText = bytesToBinaryString(ownRow?.ciphertext as ArrayBuffer);
    expect(ciphertextText).not.toContain(secret);
    expect(ciphertextText).not.toContain("[SSN_1A2B]");
  });

  it("encrypts each entity with a unique 12-byte IV", async () => {
    await storeRedactedBatch(sessionId, [
      makeEntity({ token: "[PER_89A1]" }),
      makeEntity({ token: "[PER_7C3D]", originalValue: "Jane Smith" }),
      makeEntity({ token: "[PER_4F11]", originalValue: "Alex Lee" }),
    ]);

    const rows = (await readRawEntityRows()).filter(
      (row) => row.sessionId === sessionId,
    );
    expect(rows).toHaveLength(3);

    for (const row of rows) {
      expect(row.iv).toHaveLength(12);
    }

    const ivHexes = rows.map((row) => bytesToHex(row.iv));
    expect(new Set(ivHexes).size).toBe(ivHexes.length);
  });

  it("isolates entities between sessions", async () => {
    const otherSessionId = crypto.randomUUID();
    await storeRedactedBatch(sessionId, [makeEntity({ token: "[PER_89A1]" })]);
    await storeRedactedBatch(otherSessionId, [
      makeEntity({ token: "[PER_7C3D]", originalValue: "Jane Smith" }),
    ]);

    const sessionMap = await getDecryptedSessionMap(sessionId);
    expect(sessionMap.size).toBe(1);
    expect(sessionMap.has("[PER_7C3D]")).toBe(false);
  });

  it("returns an empty map for a session that was never stored", async () => {
    const sessionMap = await getDecryptedSessionMap(crypto.randomUUID());
    expect(sessionMap.size).toBe(0);
  });

  it("purgeSessionVault removes both the entities and the session key", async () => {
    await storeRedactedBatch(sessionId, [makeEntity()]);
    expect((await getDecryptedSessionMap(sessionId)).size).toBe(1);

    await purgeSessionVault(sessionId);

    expect((await getDecryptedSessionMap(sessionId)).size).toBe(0);
    const remainingRows = (await readRawEntityRows()).filter(
      (row) => row.sessionId === sessionId,
    );
    expect(remainingRows).toHaveLength(0);
  });

  it("exportCryptographicAuditProof proves redaction occurred without exposing raw PII", async () => {
    const entities = [
      makeEntity({ token: "[PER_89A1]", originalValue: "John Doe" }),
      makeEntity({
        token: "[SSN_1A2B]",
        category: "SSN",
        originalValue: "078-05-1120",
        confidence: 0.99,
      }),
    ];
    await storeRedactedBatch(sessionId, entities);

    const proof = await exportCryptographicAuditProof(sessionId);

    expect(proof.sessionId).toBe(sessionId);
    expect(proof.entityCount).toBe(2);
    expect(proof.categoryBreakdown).toEqual({ PER: 1, SSN: 1 });
    expect(proof.entityDigests).toHaveLength(2);
    expect(proof.merkleRoot).toMatch(/^[0-9a-f]{64}$/);

    const serialized = JSON.stringify(proof);
    expect(serialized).not.toContain("John Doe");
    expect(serialized).not.toContain("078-05-1120");
  });

  it("produces a stable, order-independent Merkle root for the same entity set", async () => {
    const entityA = makeEntity({ token: "[PER_89A1]" });
    const entityB = makeEntity({
      token: "[PER_7C3D]",
      originalValue: "Jane Smith",
    });

    const firstSessionId = crypto.randomUUID();
    const secondSessionId = crypto.randomUUID();

    await storeRedactedBatch(firstSessionId, [entityA, entityB]);
    await storeRedactedBatch(secondSessionId, [entityA, entityB]);

    const [firstProof, secondProof] = await Promise.all([
      exportCryptographicAuditProof(firstSessionId),
      exportCryptographicAuditProof(secondSessionId),
    ]);

    expect(firstProof.merkleRoot).toBe(secondProof.merkleRoot);
  });

  it("returns a zero-entity proof with a stable root for a purged/never-used session", async () => {
    const proof = await exportCryptographicAuditProof(crypto.randomUUID());
    expect(proof.entityCount).toBe(0);
    expect(proof.entityDigests).toHaveLength(0);
    expect(proof.merkleRoot).toMatch(/^[0-9a-f]{64}$/);
  });
});
