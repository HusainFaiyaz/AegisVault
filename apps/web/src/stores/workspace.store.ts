import type { RedactedEntity } from "@aegis/shared";
import { create } from "zustand";
import type { IngestionJobState } from "../lib/chat-protocol.js";

const SESSION_STORAGE_KEY = "aegis.vault-session";

export type XRayMode = "raw" | "wire";

export interface ScrubMeasurement {
  ms: number;
  kind: "text" | "voice";
  entityCount: number;
}

/** A sanitized document this session has sent for indexing. */
export interface IndexedDocument {
  documentId: string;
  /** Already scrubbed: file names can contain PII too. */
  fileName: string;
  jobId: string;
  state: IngestionJobState;
  progress: number;
  entityCount: number;
  submittedAt: number;
}

interface WorkspaceState {
  /** Redaction session: scopes the HMAC key, the vault key and the vault rows. */
  sessionId: string;
  /**
   * Decrypted vault contents, token -> entity. Lives only in memory for
   * rendering pills; outbound payloads are built from redacted text and
   * pass the egress guard, so this map never reaches the network.
   */
  vault: ReadonlyMap<string, RedactedEntity>;
  vaultLoaded: boolean;
  lastScrub: ScrubMeasurement | null;
  documents: IndexedDocument[];
  xray: XRayMode;
  drawerOpen: boolean;

  setVault: (vault: ReadonlyMap<string, RedactedEntity>) => void;
  recordScrub: (measurement: ScrubMeasurement) => void;
  addDocument: (document: IndexedDocument) => void;
  updateDocument: (documentId: string, patch: Partial<IndexedDocument>) => void;
  setXray: (mode: XRayMode) => void;
  setDrawerOpen: (open: boolean) => void;
  /** Starts a fresh session after a purge: new id, empty vault, no documents. */
  rotateSession: () => void;
}

function readStoredSession(): string {
  try {
    const existing = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (existing !== null && existing.length > 0) return existing;
  } catch {
    // Storage disabled (private mode, sandboxed iframe): use an in-memory id.
  }
  return writeNewSession();
}

function writeNewSession(): string {
  const id = crypto.randomUUID();
  try {
    sessionStorage.setItem(SESSION_STORAGE_KEY, id);
  } catch {
    // See above.
  }
  return id;
}

export const useWorkspace = create<WorkspaceState>()((set) => ({
  sessionId: typeof sessionStorage === "undefined" ? crypto.randomUUID() : readStoredSession(),
  vault: new Map(),
  vaultLoaded: false,
  lastScrub: null,
  documents: [],
  xray: "raw",
  drawerOpen: false,

  setVault: (vault) => set({ vault, vaultLoaded: true }),
  recordScrub: (lastScrub) => set({ lastScrub }),
  addDocument: (document) => set((state) => ({ documents: [...state.documents, document] })),
  updateDocument: (documentId, patch) =>
    set((state) => ({
      documents: state.documents.map((document) =>
        document.documentId === documentId ? { ...document, ...patch } : document,
      ),
    })),
  setXray: (xray) => set({ xray }),
  setDrawerOpen: (drawerOpen) => set({ drawerOpen }),
  rotateSession: () =>
    set({
      sessionId: writeNewSession(),
      vault: new Map(),
      vaultLoaded: true,
      lastScrub: null,
      documents: [],
    }),
}));
