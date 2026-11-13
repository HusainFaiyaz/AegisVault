import { NetworkProofDrawer } from "./components/NetworkProofDrawer.js";
import { RedactionStudioPane } from "./components/RedactionStudioPane.js";
import { TelemetryHeader } from "./components/TelemetryHeader.js";
import { ZeroKnowledgeCopilotPane } from "./components/ZeroKnowledgeCopilotPane.js";
import { useRedactionSession } from "./hooks/useRedactionSession.js";
import { useWorkspace } from "./stores/workspace.store.js";

/**
 * Split-screen zero-trust workspace:
 *
 *   ┌ TelemetryHeader ────────────────────────────────────────┐
 *   │ RedactionStudioPane      │ ZeroKnowledgeCopilotPane      │
 *   ├ NetworkProofDrawer (collapsible) ───────────────────────┤
 *
 * One redaction session (scrubber worker + HMAC key + vault key) is shared
 * by both panes, so a name tokenised in a document and the same name typed
 * into the copilot produce the same token.
 */
export function App() {
  const session = useRedactionSession();
  const vault = useWorkspace((state) => state.vault);
  const vaultLoaded = useWorkspace((state) => state.vaultLoaded);
  const lastScrub = useWorkspace((state) => state.lastScrub);
  const ready = session.status === "ready";

  return (
    <div className="flex h-dvh flex-col bg-stone-100 text-stone-900">
      <TelemetryHeader
        status={session.status}
        device={session.device}
        progress={session.progress}
        error={session.error}
        vaultEntityCount={vault.size}
        vaultLoaded={vaultLoaded}
        lastScrub={lastScrub}
        sessionId={session.sessionId}
        purging={session.purging}
        onPurge={() => void session.purge()}
      />
      <main className="min-h-0 flex-1 overflow-y-auto lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:divide-x lg:divide-stone-200 lg:overflow-hidden">
        <RedactionStudioPane
          scrubberReady={ready}
          scrubText={session.scrubText}
          transcribeAndScrub={session.transcribeAndScrub}
        />
        <ZeroKnowledgeCopilotPane
          key={session.sessionId}
          scrubberReady={ready}
          scrubText={session.scrubText}
          loadLookup={session.loadLookup}
        />
      </main>
      <NetworkProofDrawer />
    </div>
  );
}
