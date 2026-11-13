import { networkRecorder } from "../stores/network-log.store.js";
import { createWireClient } from "./wire-client.js";

/** App-wide wire client: guarded, and recorded into the Network Proof drawer. */
export const apiClient = createWireClient({
  baseUrl: (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/+$/, ""),
  recorder: networkRecorder,
});
