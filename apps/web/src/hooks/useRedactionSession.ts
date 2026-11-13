import { useCallback, useEffect, useState } from "react";
import { getDecryptedSessionMap, purgeSessionVault } from "../lib/vault.js";
import type { EntityLookupMap } from "../lib/stream-rehydrator.js";
import { useWorkspace } from "../stores/workspace.store.js";
import {
  useZeroTrustScrubber,
  type RedactionOutcome,
  type ZeroTrustScrubber,
} from "./useZeroTrustScrubber.js";

export interface ScrubOptions {
  /** Update the header's "Last scrub" telemetry (default true). */
  record?: boolean;
}

export type ScrubTextFn = (text: string, options?: ScrubOptions) => Promise<RedactionOutcome>;

export interface RedactionSession extends Omit<ZeroTrustScrubber, "scrubText"> {
  scrubText: ScrubTextFn;
  sessionId: string;
  /** Decrypts the vault and returns token -> real value for re-hydration. */
  loadLookup: () => Promise<EntityLookupMap>;
  purge: () => Promise<void>;
  purging: boolean;
}

/**
 * Binds the scrubber worker to the current vault session: every scrub is
 * timed for the telemetry header and followed by a vault re-read so pills
 * resolve immediately. Purging deletes the session's ciphertext and AES key,
 * then rotates to a new session (which also regenerates the HMAC key, so
 * old tokens can no longer be produced or resolved).
 */
export function useRedactionSession(): RedactionSession {
  const sessionId = useWorkspace((state) => state.sessionId);
  const setVault = useWorkspace((state) => state.setVault);
  const recordScrub = useWorkspace((state) => state.recordScrub);
  const rotateSession = useWorkspace((state) => state.rotateSession);
  const scrubber = useZeroTrustScrubber(sessionId);
  const [purging, setPurging] = useState(false);

  const refreshVault = useCallback(async () => {
    const vault = await getDecryptedSessionMap(sessionId);
    // Ignore a read that finishes after the session was purged and rotated.
    if (useWorkspace.getState().sessionId === sessionId) setVault(vault);
    return vault;
  }, [sessionId, setVault]);

  useEffect(() => {
    void refreshVault();
  }, [refreshVault]);

  const { scrubText: rawScrub, transcribeAndScrub: rawTranscribe } = scrubber;

  const timed = useCallback(
    async (kind: "text" | "voice", run: () => Promise<RedactionOutcome>, record = true) => {
      const startedAt = performance.now();
      const outcome = await run();
      if (record) recordScrub({ ms: performance.now() - startedAt, kind, entityCount: outcome.entities.length });
      await refreshVault();
      return outcome;
    },
    [recordScrub, refreshVault],
  );

  const scrubText = useCallback<ScrubTextFn>(
    (text, options) => timed("text", () => rawScrub(text), options?.record ?? true),
    [timed, rawScrub],
  );
  const transcribeAndScrub = useCallback(
    (audio: Float32Array) => timed("voice", () => rawTranscribe(audio)),
    [timed, rawTranscribe],
  );

  const loadLookup = useCallback(async (): Promise<EntityLookupMap> => {
    const vault = await refreshVault();
    return new Map([...vault].map(([token, entity]) => [token, entity.originalValue]));
  }, [refreshVault]);

  const purge = useCallback(async () => {
    setPurging(true);
    try {
      await purgeSessionVault(sessionId);
      rotateSession();
    } finally {
      setPurging(false);
    }
  }, [sessionId, rotateSession]);

  return { ...scrubber, sessionId, scrubText, transcribeAndScrub, loadLookup, purge, purging };
}
