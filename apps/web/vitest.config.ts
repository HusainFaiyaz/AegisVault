import { defineConfig } from "vitest/config";

// Kept separate from vite.config.ts: Vitest 2 bundles Vite 5, whose plugin
// types do not line up with the Vite 6 React/Tailwind plugins used to build.
// Component tests render with react-dom/server, so a DOM is not needed.
export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
