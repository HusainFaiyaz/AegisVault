import type { Collection, Db } from "mongodb";

/**
 * A sanitized chunk of an uploaded document plus its `voyage-context-3`
 * embedding. Only placeholder-tokenized text is stored here; the mapping from
 * tokens back to real values lives exclusively in the browser vault.
 *
 * `sanitizedContent` and `sectionTitle` are the BM25 fields and `embedding`
 * the vector field for the Day 7 Atlas Search / Vector Search indexes.
 */
export interface DocumentChunkDoc {
  /** UUID; also the citation `chunkId` returned to the client. */
  _id: string;
  documentId: string;
  fileName: string;
  chunkIndex: number;
  sectionTitle: string;
  sanitizedContent: string;
  placeholderTokens: string[];
  embedding: number[];
  embeddingModel: string;
  createdAt: Date;
}

export const DOCUMENT_CHUNKS_COLLECTION = "document_chunks";

export function getDocumentChunkCollection(db: Db): Collection<DocumentChunkDoc> {
  return db.collection<DocumentChunkDoc>(DOCUMENT_CHUNKS_COLLECTION);
}

/** Regular B-tree indexes. Atlas Search/Vector indexes are created separately. */
export async function ensureDocumentChunkIndexes(
  collection: Collection<DocumentChunkDoc>,
): Promise<void> {
  await collection.createIndexes([
    { key: { documentId: 1, chunkIndex: 1 }, name: "documentId_chunkIndex", unique: true },
    { key: { placeholderTokens: 1 }, name: "placeholderTokens" },
  ]);
}

/** Persistence port used by the ingestion worker; swapped for a fake in tests. */
export interface DocumentChunkStore {
  /**
   * Replaces every chunk of `documentId` with `chunks`. Idempotent, so a
   * retried ingestion job never leaves duplicate or stale chunks behind.
   */
  replaceForDocument(documentId: string, chunks: DocumentChunkDoc[]): Promise<number>;
}

export function createDocumentChunkStore(collection: Collection<DocumentChunkDoc>): DocumentChunkStore {
  return {
    async replaceForDocument(documentId, chunks) {
      await collection.deleteMany({ documentId });
      if (chunks.length === 0) {
        return 0;
      }
      const result = await collection.insertMany(chunks, { ordered: true });
      return result.insertedCount;
    },
  };
}
