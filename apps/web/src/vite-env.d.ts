/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Origin of apps/api. Empty (default) means same-origin via the Vite dev proxy. */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
