# AegisVault — 10-Day Modular Engineering Roadmap

---

## Day 1: Monorepo Foundation, Docker Infra & Shared Zero-Trust Contracts
- **Status:** `[x] Completed`
- **Completion Summary (2026-10-14):** Scaffolded the pnpm/Turborepo monorepo root (`package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `.gitignore`, `.env.example`) and `docker-compose.yml` (MongoDB Atlas Local + Redis). Built `packages/shared` with Zod contracts (`EntityCategoryEnum`, `PlaceholderTokenRegex`, `RedactedEntitySchema`, `SanitizedDocumentUploadSchema`, `CitationChunkSchema`) and `detectRawPiiLeakage`/`hasRawPiiLeakage` in `pii-leakage.guard.ts`, covered by 17 Vitest unit tests (SSN/MRN/IBAN/credit card/email/phone detection, placeholder permissiveness, mixed-content cases). `pnpm install && pnpm turbo run typecheck && pnpm turbo run test` passes clean (2 tasks, 17/17 tests, 0 errors).
- **Target Package:** Root + `packages/shared`
- **Files to Create:**
  - `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `.gitignore`, `.env.example`
  - `docker-compose.yml` (MongoDB Atlas Local `mongodb/mongodb-atlas-local:8.0` + Redis `redis:7-alpine`)
  - `packages/shared/src/schemas/pii.schema.ts` (`EntityCategoryEnum`, `RedactedEntitySchema`, `PlaceholderTokenRegex`)
  - `packages/shared/src/schemas/document.schema.ts` (`SanitizedDocumentUploadSchema`, `CitationChunkSchema`)
  - `packages/shared/src/guards/pii-leakage.guard.ts` (`detectRawPiiLeakage(text)` checking SSNs, MRNs, IBANs, credit cards, emails, and phones)
  - `packages/shared/src/__tests__/pii-leakage.guard.test.ts`
- **Deliverable Specs:**
  - Configure Turborepo pipelines (`build`, `typecheck`, `test`, `dev`).
  - Write 12+ Vitest unit tests verifying `detectRawPiiLeakage` catches raw HIPAA/financial PII while permitting `[PER_89A1]`, `[MRN_3F90]`, and `[SSN_1A2B]` placeholders.
- **Verification Gate:** `pnpm install && pnpm turbo run typecheck && pnpm turbo run test`
- **Git Commit Message:** `feat(day-01): scaffold pnpm turborepo, docker infra, and shared zero-trust zod contracts`

---

## Day 2: Deterministic HMAC Pseudonymizer & Sliding-Window SSE Re-Hydrator
- **Status:** `[ ] Pending`
- **Target Package:** `apps/web` (Core Crypto & Stream Engine)
- **Files to Create:**
  - `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/vite.config.ts`
  - `apps/web/src/lib/pseudonymizer.ts` (`generateDeterministicToken(sessionKey, category, rawValue)` using Web Crypto `HMAC-SHA256` -> `[CATEGORY_HEX4]`)
  - `apps/web/src/lib/stream-rehydrator.ts` (`createRehydrationTransformStream(entityLookupMap)` using `TransformStream<string, StreamSegment>`)
  - `apps/web/src/lib/__tests__/stream-rehydrator.test.ts`
- **Deliverable Specs:**
  - Ensure identical entities (case/whitespace normalized, e.g., `"John Doe"` and `"  john doe "`) always produce the exact same `[PER_XXXX]` token within a session.
  - Implement a lookahead buffer in `stream-rehydrator.ts` that holds partial bracket chunks across arbitrary SSE boundaries (e.g., `["Patient ", "[PER", "_89", "A1]", " is stable"]`) and emits structured `{ type: 'text' | 'entity', content, token, originalValue }` segments.
- **Verification Gate:** `pnpm --filter @aegis/web test && pnpm turbo run typecheck`
- **Git Commit Message:** `feat(day-02): implement HMAC-SHA256 pseudonymizer and sliding-window SSE stream rehydrator`

---

## Day 3: Web Crypto AES-GCM 256-Bit Local Vault & IndexedDB Engine
- **Status:** `[ ] Pending`
- **Target Package:** `apps/web` (Encrypted Persistence Layer)
- **Files to Create:**
  - `apps/web/src/lib/vault.ts` (Web Crypto `AES-GCM` 256-bit key generation + `idb` IndexedDB wrapper)
  - `apps/web/src/lib/audit-receipt.ts` (Zero-Knowledge cryptographic receipt generator proving local redaction occurred)
  - `apps/web/src/lib/__tests__/vault.test.ts` (using `fake-indexeddb` + Node Web Crypto)
- **Deliverable Specs:**
  - Generate non-extractable `CryptoKey` objects stored in IndexedDB.
  - Encrypt each `{ token, originalValue, category, confidence }` record with a unique 12-byte IV via `AES-GCM` before storing in IndexedDB.
  - Support `storeRedactedBatch()`, `getDecryptedSessionMap()`, `purgeSessionVault()`, and `exportCryptographicAuditProof()`.
- **Verification Gate:** `pnpm --filter @aegis/web test && pnpm turbo run typecheck`
- **Git Commit Message:** `feat(day-03): build AES-GCM 256-bit encrypted IndexedDB vault and zero-knowledge audit proofs`

---

## Day 4: WebGPU NER + Whisper Speech-to-Text Worker Pipeline
- **Status:** `[ ] Pending`
- **Target Package:** `apps/web` (Browser Edge AI Layer)
- **Files to Create:**
  - `apps/web/src/workers/pii-scrubber.worker.ts` (`@huggingface/transformers` v3 WebGPU pipeline + hybrid regex/NER span resolver)
  - `apps/web/src/workers/scrubber-span-merger.ts` (pure function resolving overlapping NER & regex character offsets)
  - `apps/web/src/hooks/useZeroTrustScrubber.ts` (React 19 typed worker hook + IndexedDB vault sync)
  - `apps/web/src/workers/__tests__/scrubber-span-merger.test.ts`
- **Deliverable Specs:**
  - Load `Xenova/bert-base-NER` (token classification) and `onnx-community/whisper-tiny.en` (voice transcription) inside the Web Worker with `device: "webgpu"` and automatic fallback to `"wasm"`.
  - Extract `scrubber-span-merger.ts` as a pure testable module that merges ML spans (`PER`, `ORG`, `LOC`) with regex spans (`SSN`, `MRN`, `IBAN`, `EMAIL`, `PHONE`), resolves overlaps by priority/length, and replaces spans with deterministic tokens from `pseudonymizer.ts`.
- **Verification Gate:** `pnpm --filter @aegis/web test && pnpm turbo run typecheck`
- **Git Commit Message:** `feat(day-04): add WebGPU Transformers.js NER/Whisper worker and hybrid span merger`

---

## Day 5: Express 5 Zero-Knowledge Gateway & PII Ingress Guard
- **Status:** `[ ] Pending`
- **Target Package:** `apps/api` (Backend Core & Security Boundary)
- **Files to Create:**
  - `apps/api/package.json`, `apps/api/tsconfig.json`
  - `apps/api/src/app.ts`, `apps/api/src/server.ts`, `apps/api/src/config/env.ts`, `apps/api/src/config/db.ts`
  - `apps/api/src/middleware/pii-guard.middleware.ts` (Express 5 middleware invoking `detectRawPiiLeakage` on `req.body` and rejecting leaks with HTTP 422)
  - `apps/api/src/routes/health.routes.ts`
  - `apps/api/src/__tests__/pii-guard.middleware.test.ts` (Supertest integration suite)
- **Deliverable Specs:**
  - Configure Express 5 with `pino` structured logging, helmet, CORS, and correlation trace IDs.
  - Prove via Supertest that sending any raw SSN, MRN, email, or phone number to `/api/v1/*` immediately returns `422 Unprocessable Entity` (`ZERO_TRUST_VIOLATION`) without touching the database or LLM.
- **Verification Gate:** `pnpm --filter @aegis/api test && pnpm turbo run typecheck`
- **Git Commit Message:** `feat(day-05): bootstrap Express 5 server with zero-knowledge PII ingress guard middleware`

---

## Day 6: BullMQ Async Ingestion Pipeline & Voyage AI `voyage-context-3` Embeddings
- **Status:** `[ ] Pending`
- **Target Package:** `apps/api` (Document Ingestion & Contextual Embeddings)
- **Files to Create:**
  - `apps/api/src/models/document-chunk.model.ts` (Mongoose/MongoDB model for sanitized chunks + vector embeddings)
  - `apps/api/src/services/chunker.service.ts` (Semantic Markdown/Section chunker preserving placeholder tokens)
  - `apps/api/src/services/voyage.service.ts` (`voyage-context-3` embeddings + `rerank-2.5` client with deterministic mock fallback when `VOYAGE_API_KEY="mock"`)
  - `apps/api/src/workers/ingestion.worker.ts` (BullMQ background worker)
  - `apps/api/src/routes/documents.routes.ts` (`POST /api/v1/documents` -> `202 Accepted` + job status polling endpoint)
  - `apps/api/src/__tests__/ingestion.test.ts`
- **Deliverable Specs:**
  - Offload sanitized document chunking and `voyage-context-3` embedding generation to BullMQ so document uploads respond in under 25ms with `202 Accepted`.
- **Verification Gate:** `pnpm --filter @aegis/api test && pnpm turbo run typecheck`
- **Git Commit Message:** `feat(day-06): implement BullMQ document ingestion worker and Voyage AI contextual embeddings`

---

## Day 7: MongoDB Atlas `$rankFusion` Hybrid RAG & Voyage `rerank-2.5` Service
- **Status:** `[ ] Pending`
- **Target Package:** `apps/api` (Hybrid Search & Reranking Engine)
- **Files to Create:**
  - `apps/api/src/services/retrieval.service.ts` (MongoDB native `$rankFusion` pipeline builder + Voyage `rerank-2.5` top-25-to-top-5 filter)
  - `apps/api/src/scripts/setup-indexes.ts` (Creates Atlas Vector Search index + Atlas BM25 Search index programmatically)
  - `apps/api/src/__tests__/retrieval.service.test.ts`
- **Deliverable Specs:**
  - Construct the native MongoDB `$rankFusion` stage combining `vectorPipeline` (`$vectorSearch`) and `fullTextPipeline` (`$search` BM25 on `sanitizedContent` and `sectionTitle`), ensuring exact anonymized identifiers like `[MRN_3F90]` or ISO codes match via BM25 while semantic concepts match via vectors.
  - Pass the top 25 fused results through `voyageService.rerank()` to return the top 5 highest-precision chunks with `scoreDetails`.
- **Verification Gate:** `pnpm --filter @aegis/api test && pnpm turbo run typecheck`
- **Git Commit Message:** `feat(day-07): build MongoDB $rankFusion hybrid retrieval pipeline with Voyage rerank-2.5`

---

## Day 8: Vercel AI SDK Streaming Controller & Citation Grounding Engine
- **Status:** `[ ] Pending`
- **Target Package:** `apps/api` (Streaming Reasoning Layer)
- **Files to Create:**
  - `apps/api/src/services/prompt-builder.service.ts` (Constructs zero-trust system prompt enforcing exact `[CATEGORY_HEX4]` token preservation and `[CIT-XX]` markers)
  - `apps/api/src/routes/chat.routes.ts` (`POST /api/v1/chat/stream` using Vercel AI SDK `streamText` + mock stream mode for offline testing)
  - `apps/api/src/middleware/rate-limit.middleware.ts` (Redis token-bucket rate limiter)
  - `apps/api/src/__tests__/chat.routes.test.ts`
- **Deliverable Specs:**
  - Stream retrieval metadata (the 5 reranked citations + latency metrics) alongside the LLM token stream so the client can inspect grounding sources and re-hydrate placeholders in real time.
- **Verification Gate:** `pnpm --filter @aegis/api test && pnpm turbo run typecheck`
- **Git Commit Message:** `feat(day-08): add Vercel AI SDK streaming chat endpoint with citation grounding and rate limiting`

---

## Day 9: React 19 Split-Screen Zero-Trust Studio & X-Ray Inspector UI
- **Status:** `[ ] Pending`
- **Target Package:** `apps/web` (Production Showcase Interface)
- **Files to Create:**
  - `apps/web/src/components/TelemetryHeader.tsx` (WebGPU FP16/Q4 status badge, AES-GCM Vault lock indicator, scrubbing latency badge, "Purge Vault" button)
  - `apps/web/src/components/RedactionStudioPane.tsx` (Left Pane: Document & Voice input, 1-click HIPAA Clinical & SOC2 Financial presets, interactive **X-Ray Toggle** switching between Raw Highlighted PII View and Cloud Wire View)
  - `apps/web/src/components/ZeroKnowledgeCopilotPane.tsx` (Right Pane: Streaming chat wired through `stream-rehydrator.ts`)
  - `apps/web/src/components/HydratedEntityPill.tsx` (Interactive pill displaying decrypted real name with hover popover showing `[PER_89A1]`, confidence, and AES-GCM status)
  - `apps/web/src/components/NetworkProofDrawer.tsx` (Live side-by-side inspector showing raw outbound JSON payload and raw inbound SSE stream chunks)
  - `apps/web/src/App.tsx`, `apps/web/src/main.tsx`
- **Deliverable Specs:**
  - Full split-screen workspace built with React 19 and Tailwind CSS v4.
- **Verification Gate:** `pnpm turbo run typecheck && pnpm turbo run test && pnpm turbo run build`
- **Git Commit Message:** `feat(day-09): build React 19 split-screen zero-trust studio, X-Ray toggle, and network proof drawer`

---

## Day 10: Seed Data, E2E Zero-Leakage Playwright Suite, CI/CD & ADRs
- **Status:** `[ ] Pending`
- **Target Package:** Root + E2E + Documentation
- **Files to Create:**
  - `scripts/seed-demo.ts` (Populates sample anonymized Cardiology Protocol & M&A Credit Agreement chunks)
  - `e2e/zero-trust-flow.spec.ts` (Playwright test intercepting `page.on('request')` to mathematically assert zero raw PII strings ever cross the network wire)
  - `.github/workflows/ci.yml` (Runs `typecheck`, `test`, and `build` on every push/PR)
  - `docs/adr/001-webgpu-client-side-redaction.md`, `docs/adr/002-sliding-window-sse-rehydration.md`, `docs/adr/003-mongodb-rankfusion-voyage-rerank.md`
  - `README.md` (Executive architecture diagrams, 1-command Docker quickstart, security invariants)
- **Deliverable Specs:**
  - Complete production polish, ADRs, and automated CI pipeline.
- **Verification Gate:** `pnpm turbo run typecheck && pnpm turbo run test && pnpm turbo run build`
- **Git Commit Message:** `feat(day-10): add Playwright zero-leakage E2E tests, GitHub Actions CI, seed script, and ADRs`
