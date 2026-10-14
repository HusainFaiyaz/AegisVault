# AegisVault — 10-Day Modular Build Rules

## Core Security Invariant (NON-NEGOTIABLE)
1. **Zero Raw PII Egress:** Raw unredacted text, audio, or PII entities MUST NEVER leave the browser or appear in payloads sent to `apps/api`.
2. **Server-Side Zero-Knowledge Proof:** `apps/api` rejects any request containing unmasked SSNs, MRNs, credit cards, emails, or phone numbers with HTTP 422 (`ZERO_TRUST_VIOLATION`).
3. **Encrypted Local Vault Only:** Mappings between deterministic tokens (`[PER_89A1]`) and real PII live exclusively in browser IndexedDB encrypted with Web Crypto `AES-GCM` (256-bit).

## Tech Stack Standards
- **Monorepo:** `pnpm` workspaces + `Turborepo` (`packages/shared`, `apps/web`, `apps/api`). Strict TypeScript (`noImplicitAny: true`, zero `any`).
- **Frontend (`apps/web`):** Vite + React 19 + TanStack Router + TanStack Query v5 + Zustand + Tailwind CSS v4 + shadcn/ui.
- **Browser Edge AI:** `@huggingface/transformers` v3+ inside a Web Worker (`device: "webgpu"` with `"wasm"` fallback).
- **Backend (`apps/api`):** Express 5 (native async error handling), `pino`, `ioredis`, `bullmq`, Vercel AI SDK (`ai`).
- **Hybrid RAG:** MongoDB Atlas v8.1+ native `$rankFusion` (`$vectorSearch` + BM25 `$search`) + Voyage AI (`voyage-context-3` & `rerank-2.5`). Include a deterministic mock fallback when `VOYAGE_API_KEY="mock"` so CI and local tests pass offline.

## Modular Execution Rule
- Never build future days ahead of schedule. When asked to execute **Day N** (or via `/day N`), read `ROADMAP.md`, implement ONLY Day N's scope, pass Day N's verification gate, update `ROADMAP.md`, and commit + push to GitHub.
