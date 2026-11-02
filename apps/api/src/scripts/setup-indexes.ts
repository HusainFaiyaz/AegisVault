import { pathToFileURL } from "node:url";
import type { Db, Document, SearchIndexDescription } from "mongodb";
import type { Logger } from "pino";
import { createLogger } from "../app.js";
import { connectDb, disconnectDb } from "../config/db.js";
import { loadEnv } from "../config/env.js";
import {
  DOCUMENT_CHUNKS_COLLECTION,
  DOCUMENT_CHUNKS_SEARCH_INDEX,
  DOCUMENT_CHUNKS_VECTOR_INDEX,
  ensureDocumentChunkIndexes,
  getDocumentChunkCollection,
} from "../models/document-chunk.model.js";
import { EMBEDDING_DIMENSIONS } from "../services/voyage.service.js";

/**
 * Creates (or updates) the two Atlas indexes `retrieval.service.ts` queries:
 *
 * - `document_chunks_vector` (vectorSearch): cosine over the 1024-d
 *   `voyage-context-3` `embedding`, with `documentId` as a pre-filter field.
 * - `document_chunks_text` (search, BM25): `sanitizedContent` and
 *   `sectionTitle` with `lucene.standard` (keeps `MRN_3F90` and `J18.9` as
 *   single terms), and `placeholderTokens` / `documentId` as un-analyzed
 *   `token` fields for exact matching and filtering.
 *
 * Idempotent: an index whose live definition already contains the desired
 * one is left alone, so re-running never triggers a needless rebuild.
 *
 * Usage: `pnpm --filter @aegis/api setup:indexes [--no-wait]`
 */

export function buildSearchIndexDescriptions(
  dimensions: number = EMBEDDING_DIMENSIONS,
): SearchIndexDescription[] {
  return [
    {
      name: DOCUMENT_CHUNKS_VECTOR_INDEX,
      type: "vectorSearch",
      definition: {
        fields: [
          { type: "vector", path: "embedding", numDimensions: dimensions, similarity: "cosine" },
          { type: "filter", path: "documentId" },
        ],
      },
    },
    {
      name: DOCUMENT_CHUNKS_SEARCH_INDEX,
      type: "search",
      definition: {
        analyzer: "lucene.standard",
        searchAnalyzer: "lucene.standard",
        mappings: {
          dynamic: false,
          fields: {
            sanitizedContent: { type: "string", analyzer: "lucene.standard" },
            sectionTitle: { type: "string", analyzer: "lucene.standard" },
            placeholderTokens: { type: "token" },
            documentId: { type: "token" },
          },
        },
      },
    },
  ];
}

export interface SearchIndexInfo {
  name: string;
  type?: string;
  status?: string;
  queryable?: boolean;
  latestDefinition?: Document;
}

/** The slice of the driver's search-index API this script needs; faked in tests. */
export interface SearchIndexAdmin {
  list(): Promise<SearchIndexInfo[]>;
  create(descriptions: SearchIndexDescription[]): Promise<string[]>;
  update(name: string, definition: Document): Promise<void>;
}

export async function ensureCollectionExists(db: Db, name: string): Promise<boolean> {
  const existing = await db.listCollections({ name }, { nameOnly: true }).toArray();
  if (existing.length > 0) {
    return false;
  }
  // Search indexes cannot be created on a collection that does not exist yet.
  await db.createCollection(name);
  return true;
}

export function createSearchIndexAdmin(db: Db, collectionName = DOCUMENT_CHUNKS_COLLECTION): SearchIndexAdmin {
  const collection = db.collection(collectionName);
  return {
    async list() {
      const docs: Document[] = await collection.listSearchIndexes().toArray();
      return docs.map((doc) => ({
        name: String(doc["name"]),
        ...(typeof doc["type"] === "string" ? { type: doc["type"] } : {}),
        ...(typeof doc["status"] === "string" ? { status: doc["status"] } : {}),
        ...(typeof doc["queryable"] === "boolean" ? { queryable: doc["queryable"] } : {}),
        ...(typeof doc["latestDefinition"] === "object" && doc["latestDefinition"] !== null
          ? { latestDefinition: doc["latestDefinition"] as Document }
          : {}),
      }));
    },
    create: (descriptions) => collection.createSearchIndexes(descriptions),
    update: (name, definition) => collection.updateSearchIndex(name, definition),
  };
}

/**
 * True when every key of `desired` is present in `actual` with an equal value
 * (arrays element-wise). Atlas fills in defaults on stored definitions, so an
 * exact equality check would report drift on every run.
 */
export function definitionContains(actual: unknown, desired: unknown): boolean {
  if (Array.isArray(desired)) {
    return (
      Array.isArray(actual) &&
      actual.length === desired.length &&
      desired.every((item, i) => definitionContains(actual[i], item))
    );
  }
  if (typeof desired === "object" && desired !== null) {
    if (typeof actual !== "object" || actual === null || Array.isArray(actual)) {
      return false;
    }
    const actualRecord = actual as Record<string, unknown>;
    return Object.entries(desired as Record<string, unknown>).every(([key, value]) =>
      definitionContains(actualRecord[key], value),
    );
  }
  return actual === desired;
}

export interface EnsureSearchIndexesOptions {
  waitUntilQueryable?: boolean;
  pollIntervalMs?: number;
  timeoutMs?: number;
  logger?: Pick<Logger, "info" | "warn">;
  sleep?: (ms: number) => Promise<void>;
}

export interface EnsureSearchIndexesResult {
  created: string[];
  updated: string[];
  unchanged: string[];
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function ensureSearchIndexes(
  admin: SearchIndexAdmin,
  descriptions: readonly SearchIndexDescription[],
  options: EnsureSearchIndexesOptions = {},
): Promise<EnsureSearchIndexesResult> {
  const existing = new Map((await admin.list()).map((info) => [info.name, info]));
  const result: EnsureSearchIndexesResult = { created: [], updated: [], unchanged: [] };
  const toCreate: SearchIndexDescription[] = [];

  for (const description of descriptions) {
    const name = description.name;
    if (!name) {
      throw new Error("Search index descriptions must be named");
    }
    const current = existing.get(name);
    if (!current) {
      toCreate.push(description);
      result.created.push(name);
    } else if (current.type !== undefined && description.type !== undefined && current.type !== description.type) {
      throw new Error(
        `Search index ${name} exists as type "${current.type}", expected "${description.type}"; drop it first`,
      );
    } else if (!definitionContains(current.latestDefinition, description.definition)) {
      await admin.update(name, description.definition);
      result.updated.push(name);
    } else {
      result.unchanged.push(name);
    }
  }
  if (toCreate.length > 0) {
    await admin.create(toCreate);
  }
  options.logger?.info(result, "atlas search indexes reconciled");

  if (options.waitUntilQueryable ?? true) {
    const names = descriptions.map((d) => d.name).filter((n): n is string => Boolean(n));
    await waitForQueryable(admin, names, options);
  }
  return result;
}

async function waitForQueryable(
  admin: SearchIndexAdmin,
  names: readonly string[],
  options: EnsureSearchIndexesOptions,
): Promise<void> {
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  const timeoutMs = options.timeoutMs ?? 300_000;
  const sleep = options.sleep ?? defaultSleep;
  let waited = 0;

  for (;;) {
    const byName = new Map((await admin.list()).map((info) => [info.name, info]));
    const failed = names.filter((name) => byName.get(name)?.status === "FAILED");
    if (failed.length > 0) {
      throw new Error(`Search index build failed: ${failed.join(", ")}`);
    }
    const pending = names.filter((name) => byName.get(name)?.queryable !== true);
    if (pending.length === 0) {
      return;
    }
    if (waited >= timeoutMs) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for search indexes: ${pending.join(", ")}`);
    }
    options.logger?.info({ pending }, "waiting for search indexes to become queryable");
    await sleep(pollIntervalMs);
    waited += pollIntervalMs;
  }
}

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger(env);
  const wait = !process.argv.includes("--no-wait");
  try {
    const db = await connectDb(env.MONGODB_URI, logger);
    if (await ensureCollectionExists(db, DOCUMENT_CHUNKS_COLLECTION)) {
      logger.info({ collection: DOCUMENT_CHUNKS_COLLECTION }, "collection created");
    }
    await ensureDocumentChunkIndexes(getDocumentChunkCollection(db));
    await ensureSearchIndexes(createSearchIndexAdmin(db), buildSearchIndexDescriptions(), {
      waitUntilQueryable: wait,
      logger,
    });
    logger.info("index setup complete");
  } finally {
    await disconnectDb();
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main().catch((error: unknown) => {
    console.error("setup-indexes failed", error);
    process.exit(1);
  });
}
