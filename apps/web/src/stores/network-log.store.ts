import { create } from "zustand";
import type { WireChunk, WireExchange, WireRecorder } from "../lib/wire-client.js";

/** Oldest exchanges are dropped past this; the drawer is a live view, not an archive. */
export const MAX_EXCHANGES = 60;

interface NetworkLogState {
  exchanges: WireExchange[];
  selectedId: string | null;
  select: (id: string | null) => void;
  clear: () => void;
}

export const useNetworkLog = create<NetworkLogState>()((set) => ({
  exchanges: [],
  selectedId: null,
  select: (id) => set({ selectedId: id }),
  clear: () => set({ exchanges: [], selectedId: null }),
}));

function patchExchange(id: string, patch: (exchange: WireExchange) => WireExchange): void {
  useNetworkLog.setState((state) => ({
    exchanges: state.exchanges.map((exchange) => (exchange.id === id ? patch(exchange) : exchange)),
  }));
}

/** Feeds the wire client's recording hooks into the store. */
export const networkRecorder: WireRecorder = {
  begin(exchange) {
    useNetworkLog.setState((state) => ({
      exchanges: [...state.exchanges, exchange].slice(-MAX_EXCHANGES),
      // Follow the newest exchange unless the user pinned an older one.
      selectedId:
        state.selectedId === null || state.selectedId === state.exchanges.at(-1)?.id
          ? exchange.id
          : state.selectedId,
    }));
  },
  update(id, patch) {
    patchExchange(id, (exchange) => ({ ...exchange, ...patch }));
  },
  appendChunk(id, chunk: WireChunk) {
    patchExchange(id, (exchange) => ({ ...exchange, chunks: [...exchange.chunks, chunk] }));
  },
};
