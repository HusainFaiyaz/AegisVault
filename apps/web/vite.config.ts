import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiTarget = process.env.AEGIS_API_PROXY_TARGET ?? "http://localhost:4000";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Same-origin in dev: the browser talks to /api and Vite forwards it, so
    // the API's CORS allow-list only matters for split-origin deployments.
    proxy: { "/api": { target: apiTarget, changeOrigin: true } },
  },
  // The scrubber worker imports Transformers.js and shared code, which needs
  // code-splitting; only ES-module workers support that.
  worker: { format: "es" },
  // onnxruntime-web ships its own wasm loader; pre-bundling breaks its paths.
  optimizeDeps: { exclude: ["@huggingface/transformers"] },
  build: { target: "es2022", sourcemap: true },
});
