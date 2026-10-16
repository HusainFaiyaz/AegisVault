import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { RedactedEntity } from "@aegis/shared";
import {
  generateAuditReceipt,
  type CryptographicAuditProof,
} from "./audit-receipt.js";

const VAULT_DB_NAME = "aegis-vault";
const VAULT_DB_VERSION = 1;
const KEYS_STORE = "session-keys";
const ENTITIES_STORE = "redacted-entities";
const BY_SESSION_INDEX = "by-session";

const AES_GCM_ALGORITHM = "AES-GCM";
const AES_GCM_KEY_LENGTH_BITS = 256;
const GCM_IV_LENGTH_BYTES = 12;

/**
 * A single encrypted entity record as held in IndexedDB. Only `sessionId` is
 * stored in plaintext (it identifies a redaction session, not a person);
 * `ciphertext` is the AES-GCM encryption of the full
 * `{ token, originalValue, category, confidence }` record under a unique
 * 12-byte `iv`.
 */
interface EncryptedEntityRow {
  id?: number;
  sessionId: string;
  iv: Uint8Array;
  ciphertext: ArrayBuffer;
}

interface VaultDBSchema extends DBSchema {
  [KEYS_STORE]: {
    key: string;
    value: CryptoKey;
  };
  [ENTITIES_STORE]: {
    key: number;
    value: EncryptedEntityRow;
    indexes: { [BY_SESSION_INDEX]: string };
  };
}

let dbPromise: Promise<IDBPDatabase<VaultDBSchema>> | undefined;

function getVaultDatabase(): Promise<IDBPDatabase<VaultDBSchema>> {
  dbPromise ??= openDB<VaultDBSchema>(VAULT_DB_NAME, VAULT_DB_VERSION, {
    upgrade(db) {
      db.createObjectStore(KEYS_STORE);
      const entityStore = db.createObjectStore(ENTITIES_STORE, {
        keyPath: "id",
        autoIncrement: true,
      });
      entityStore.createIndex(BY_SESSION_INDEX, "sessionId");
    },
  });
  return dbPromise;
}

/**
 * Generates a non-extractable AES-GCM 256-bit `CryptoKey`. The raw key
 * material can never be exported via `crypto.subtle.exportKey`; it can only
 * be used, via this same `CryptoKey` object, to encrypt/decrypt in place.
 */
async function generateVaultKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: AES_GCM_ALGORITHM, length: AES_GCM_KEY_LENGTH_BITS },
    false,
    ["encrypt", "decrypt"],
  );
}

async function getOrCreateSessionKey(
  db: IDBPDatabase<VaultDBSchema>,
  sessionId: string,
): Promise<CryptoKey> {
  const existing = await db.get(KEYS_STORE, sessionId);
  if (existing) {
    return existing;
  }
  const key = await generateVaultKey();
  await db.put(KEYS_STORE, key, sessionId);
  return key;
}

/**
 * Encrypts and persists a batch of redacted entities for `sessionId`. Each
 * entity is encrypted individually with a unique random IV before being
 * written, so no two ciphertexts ever share an IV/key pair.
 *
 * Encryption runs to completion before the IndexedDB transaction opens:
 * `crypto.subtle` work is asynchronous and would otherwise let the
 * transaction auto-commit between requests.
 */
export async function storeRedactedBatch(
  sessionId: string,
  entities: readonly RedactedEntity[],
): Promise<void> {
  if (entities.length === 0) {
    return;
  }

  const db = await getVaultDatabase();
  const key = await getOrCreateSessionKey(db, sessionId);

  const encryptedRows = await Promise.all(
    entities.map(async (entity): Promise<EncryptedEntityRow> => {
      const iv = crypto.getRandomValues(new Uint8Array(GCM_IV_LENGTH_BYTES));
      const plaintext = new TextEncoder().encode(JSON.stringify(entity));
      const ciphertext = await crypto.subtle.encrypt(
        { name: AES_GCM_ALGORITHM, iv },
        key,
        plaintext,
      );
      return { sessionId, iv, ciphertext };
    }),
  );

  const tx = db.transaction(ENTITIES_STORE, "readwrite");
  await Promise.all([
    ...encryptedRows.map((row) => tx.store.add(row)),
    tx.done,
  ]);
}

/**
 * Decrypts every entity stored for `sessionId` and returns them keyed by
 * their placeholder token. Returns an empty map for a session with no key
 * (never stored, or already purged) rather than throwing.
 */
export async function getDecryptedSessionMap(
  sessionId: string,
): Promise<Map<string, RedactedEntity>> {
  const db = await getVaultDatabase();
  const key = await db.get(KEYS_STORE, sessionId);
  if (!key) {
    return new Map();
  }

  const rows = await db.getAllFromIndex(
    ENTITIES_STORE,
    BY_SESSION_INDEX,
    sessionId,
  );

  const decrypted = await Promise.all(
    rows.map(async (row) => {
      const plaintext = await crypto.subtle.decrypt(
        // `.slice()` re-backs the IV with a fresh `ArrayBuffer` — the value
        // read back from IndexedDB is typed over the broader
        // `ArrayBufferLike`, which `BufferSource` does not accept directly.
        { name: AES_GCM_ALGORITHM, iv: row.iv.slice() },
        key,
        row.ciphertext,
      );
      return JSON.parse(new TextDecoder().decode(plaintext)) as RedactedEntity;
    }),
  );

  return new Map(decrypted.map((entity) => [entity.token, entity]));
}

/**
 * Permanently deletes a session's encrypted entities and its vault key.
 * Once the key is gone the ciphertext is unrecoverable, so this is the
 * effective "forget everything" operation for a session.
 */
export async function purgeSessionVault(sessionId: string): Promise<void> {
  const db = await getVaultDatabase();
  const rowIds = await db.getAllKeysFromIndex(
    ENTITIES_STORE,
    BY_SESSION_INDEX,
    sessionId,
  );

  const tx = db.transaction(ENTITIES_STORE, "readwrite");
  await Promise.all([...rowIds.map((id) => tx.store.delete(id)), tx.done]);

  await db.delete(KEYS_STORE, sessionId);
}

/**
 * Decrypts a session's vault and folds it into a zero-knowledge
 * cryptographic proof (see `audit-receipt.ts`) that redaction happened
 * locally, without the proof itself ever containing raw PII.
 */
export async function exportCryptographicAuditProof(
  sessionId: string,
): Promise<CryptographicAuditProof> {
  const sessionMap = await getDecryptedSessionMap(sessionId);
  return generateAuditReceipt(sessionId, [...sessionMap.values()]);
}
