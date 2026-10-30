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
- **Status:** `[x] Completed`
- **Completion Summary (2026-10-15):** Scaffolded `apps/web` (`package.json`, `tsconfig.json`, `vite.config.ts` with embedded Vitest config). Built `src/lib/pseudonymizer.ts` with `generateSessionHmacKey()` (non-extractable Web Crypto `HMAC-SHA256` key) and `generateDeterministicToken(sessionKey, category, rawValue)`, which case/whitespace-normalizes the raw value before signing so identical entities always collapse to the same `[CATEGORY_HEX4]` token. Built `src/lib/stream-rehydrator.ts` with `createRehydrationTransformStream(entityLookupMap)`, a `TransformStream<string, StreamSegment>` that holds an internal lookahead buffer so a `[CATEGORY_HEX4]` placeholder split arbitrarily across SSE chunk boundaries (e.g. `["Patient ", "[PER", "_89", "A1]", " is stable"]`) is still re-hydrated into one structured `entity` segment, while non-token bracket content passes through as `text`. Covered by 6 Vitest tests in `src/lib/__tests__/stream-rehydrator.test.ts` (split-token boundary, multiple entities in one chunk, unresolved lookup, invalid bracket passthrough, never-closed bracket on flush, repeated-entity token stability). `pnpm --filter @aegis/web test && pnpm turbo run typecheck` plus the full `pnpm turbo run test` pass clean (3/3 tasks, 23/23 tests across the monorepo, 0 type errors).
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
- **Status:** `[x] Completed`
- **Completion Summary (2026-10-16):** Built `apps/web/src/lib/vault.ts`, an `idb`-backed IndexedDB wrapper (`aegis-vault` DB, `session-keys` + `redacted-entities` object stores with a `by-session` index) that generates a non-extractable `AES-GCM` 256-bit `CryptoKey` per session (stored directly as a structured-clone-able `CryptoKey` object, never exported/extracted), encrypts each `{ token, originalValue, category, confidence }` record with a unique random 12-byte IV before writing, and exposes `storeRedactedBatch()`, `getDecryptedSessionMap()`, and `purgeSessionVault()`. All `crypto.subtle` encryption work completes before an IndexedDB transaction opens, avoiding the async-auto-commit race. Built `apps/web/src/lib/audit-receipt.ts` with `generateAuditReceipt()`, which hashes only the non-sensitive fields of each entity (token/category/confidence, never `originalValue`) into SHA-256 digests and folds them into a Merkle root, plus `vault.ts`'s `exportCryptographicAuditProof()`, which decrypts a session and produces this zero-knowledge proof that local redaction occurred. Covered by 9 Vitest tests in `apps/web/src/lib/__tests__/vault.test.ts` (using `fake-indexeddb` + Node's native Web Crypto) proving round-trip decryption, that raw PII/tokens never appear as plaintext in the stored ciphertext bytes, unique-IV-per-entity, session isolation, vault purge, and that the exported audit proof's JSON never contains the original raw values. `pnpm --filter @aegis/web test && pnpm turbo run typecheck` plus the full `pnpm turbo run test` pass clean (3/3 tasks, 32/32 tests across the monorepo, 0 type errors).
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
- **Status:** `[x] Completed`
- **Completion Summary (2026-10-28):** Built `apps/web/src/workers/scrubber-span-merger.ts`, a pure module that (1) detects `SSN`/`MRN`/`IBAN`/`EMAIL`/`PHONE`/`CREDIT_CARD` spans by reusing the shared `detectRawPiiLeakage` patterns (so anything `apps/api` would reject is redacted in-browser first), (2) aggregates raw BIO-tagged WordPiece NER output into `PER`/`ORG`/`LOC` character spans — Transformers.js v3 emits no character offsets, so tokens are aligned onto the source text with a sequential cursor (`ignore_labels: []`), `##` sub-words are stitched, and `MISC`/low-confidence (<0.6) tags dropped, (3) resolves overlaps by clustering transitively-overlapping spans into their union (never leaking a partially-covered fragment) labelled by category priority (regex > NER; SSN > MRN > IBAN > EMAIL > CREDIT_CARD > PHONE > PER > ORG > LOC), then length, then confidence, (4) replaces spans with deterministic tokens from `pseudonymizer.ts` and dedupes entities per token, and (5) fail-closed re-scans the redacted output with the shared guard, throwing `ZERO_TRUST_VIOLATION` if anything raw survives; plus `chunkForNer()` for the 512-token BERT window. Built `apps/web/src/workers/pii-scrubber.worker.ts`, which probes `navigator.gpu.requestAdapter()` and loads `Xenova/bert-base-NER` (eagerly) and `onnx-community/whisper-tiny.en` (lazily, on first dictation) with `device: "webgpu"`, falling back to `"wasm"` if the adapter is missing or model init fails; dictation is transcribed and scrubbed inside the worker so the raw transcript never reaches the main thread. Built `apps/web/src/hooks/useZeroTrustScrubber.ts`, a React 19 hook that spawns the module worker per session, hands it a fresh non-extractable HMAC `CryptoKey` (structured-cloned, key material never exposed), tracks `loading`/`ready`/`error` status, inference device and model-download progress, encrypts every result's entities into the Day 3 vault via `storeRedactedBatch()`, and returns only redacted text plus `originalValue`-stripped entity metadata to React. Added `@huggingface/transformers@^3.8.1`, `react@^19.3.1`, `@types/react@^19.3.0`. Covered by 14 Vitest tests in `apps/web/src/workers/__tests__/scrubber-span-merger.test.ts` (regex offsets, BIO/sub-word aggregation, MISC/confidence filtering, B-tag splitting, sequential alignment of repeated words, priority/length/union overlap resolution, deterministic tokens with entity dedupe, and full scrub output passing the shared leakage guard). `pnpm --filter @aegis/web test && pnpm turbo run typecheck` plus `pnpm turbo run test` pass clean (3/3 tasks, 46/46 tests across the monorepo, 0 type errors). Model download/WebGPU inference itself is not exercised in CI (Node test env); it is verified in-browser once the Day 9 UI lands.
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
- **Status:** `[x] Completed`
- **Completion Summary (2026-10-29):** Bootstrapped `@aegis/api` (Express 5.3, `pino` 10 + `pino-http` 11, `helmet` 8, `cors`, `mongodb` 7, `zod`, `tsx` dev runner). `config/env.ts` parses and validates env with zod at boot (`PORT`, `LOG_LEVEL`, `CORS_ORIGINS`, `BODY_LIMIT`, `MONGODB_URI`, `REDIS_URL`, `VOYAGE_API_KEY`, `AI_PROVIDER_API_KEY`) and fails fast on bad values. `config/db.ts` holds one lazily connected `MongoClient` (`connectDb`/`getDb`/`pingDb`/`disconnectDb`); nothing connects at import time. `app.ts` exposes `createApp({ env, logger, checkDb, registerApiRoutes })`: pino-http request logging with UUID correlation trace IDs (a caller's `x-request-id` is reused only if it is a UUID, echoed in the response header and every error body), raw PII masked out of logged URLs, authorization/cookie headers redacted, helmet, an allow-listed CORS origin, JSON and text/plain body parsers with a size limit, a JSON 404, and a central Express 5 error handler (async rejections handled natively; body-parser errors map to `MALFORMED_BODY`/`PAYLOAD_TOO_LARGE` and never echo the body, since Node's JSON errors quote fragments of it). Every `/api/v1` router (including Days 6-8 routes via `registerApiRoutes`) sits behind `middleware/pii-guard.middleware.ts`, which walks the URL path, query string and body without recursion, checking string values, object keys and numbers (so a card sent as a JSON number is caught) with the shared `detectRawPiiLeakage`. A leak returns `422 ZERO_TRUST_VIOLATION` listing only `{category, location, index}`; the raw value is never returned or logged. A body that cannot be parsed and scanned (e.g. `application/octet-stream`) is rejected with `415` instead of being passed through. `routes/health.routes.ts` adds liveness (`/health`, no dependencies) and readiness (`/health/ready`, Mongo ping, 503 when down). `server.ts` loads env, connects Mongo, listens, and shuts down gracefully on SIGTERM/SIGINT with a 10s forced-exit fallback. 28 Supertest tests in `src/__tests__/pii-guard.middleware.test.ts` cover: SSN/MRN/EMAIL/PHONE/CREDIT_CARD/IBAN rejected with 422 before stub DB/LLM spies run; no raw value in responses or logs; redacted placeholder payloads passed through; nested arrays, object keys, numeric cards, text/plain, query string, URL path; 415, 400 and 413 handling; trace ID generation, propagation and rejection; liveness/readiness; helmet and CORS; async error routing; JSON 404. Mutation check: removing the guard fails 15 of the 28 tests. `pnpm --filter @aegis/api test && pnpm turbo run typecheck` plus `pnpm turbo run test` pass clean (74/74 tests across shared/web/api, 0 type errors). A live boot against MongoDB was not exercised in this environment (no Docker available); `pnpm --filter @aegis/api start` needs `docker compose up -d mongodb`.
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
- **Status:** `[x] Completed`
- **Completion Summary (2026-10-30):** Added `bullmq` 5 + `ioredis` 5 to `@aegis/api`. `routes/documents.routes.ts` mounts `POST /api/v1/documents` (behind the PII guard) which validates the body with the shared `SanitizedDocumentUploadSchema` (400 `VALIDATION_ERROR` lists paths/codes only), enqueues a job and answers `202 Accepted` with `jobId`, `statusUrl` and a `Location` header; no chunking, embedding or DB work happens on the request path. `GET /api/v1/documents/jobs/:jobId` reports `queued | processing | completed | failed`, progress, attempts, result and failure reason (404 `JOB_NOT_FOUND` for unknown/malformed ids). `services/chunker.service.ts` splits on Markdown headings (heading-path section titles like `Discharge Summary > Medications`, headings inside code fences ignored), packs paragraphs, then sentences, then whitespace-split runs up to a 1,200-char budget, merges a tiny trailing chunk, and never cuts inside a `[CATEGORY_HEX4]` placeholder token. `services/voyage.service.ts` calls `/v1/contextualizedembeddings` (`voyage-context-3`, 1024-d, `input_type` document/query, oversized documents split into ~24K-token windows and ~90K-token requests) and `/v1/rerank` (`rerank-2.5`, `top_k`); errors raise `VoyageApiError` with the status only, never the response body. `VOYAGE_API_KEY="mock"` selects a deterministic offline fallback: feature-hashed unit vectors with a document-context blend (related text scores closer; the same chunk embeds differently in different documents) and a term-overlap reranker that matches placeholder tokens exactly. `models/document-chunk.model.ts` defines the `document_chunks` collection (`DocumentChunkDoc` with section title, sanitized content, placeholder tokens, embedding, model), B-tree indexes (`documentId+chunkIndex` unique, `placeholderTokens`) created at boot, and an idempotent `replaceForDocument` store. `workers/ingestion.worker.ts` holds a Redis-free `processIngestionJob` (chunk -> re-scan every chunk for raw PII and fail with `UnrecoverableError` before embedding/storing -> embed -> replace chunks with stable UUID-shaped chunk ids, so retries never duplicate), plus the BullMQ queue adapter (3 attempts, exponential backoff, bounded retention) and worker (logs ids and counts only). `server.ts` now ensures indexes, opens a Redis connection, runs the worker in-process (`INGESTION_CONCURRENCY`, default 2) and closes worker -> queue -> Redis -> Mongo on shutdown. **Shared guard fix:** `detectRawPiiLeakage` flagged ~0.7% of random UUIDs as PHONE/CREDIT_CARD (measured over 200k samples), which would have 422'd about 1 in 150 legitimate uploads; canonical UUIDs are now blanked before scanning like placeholders (2 regression tests added in `packages/shared`). 30 new tests in `src/__tests__/ingestion.test.ts` cover the 202 contract, median upload latency under 25ms, zero Voyage/DB calls on the request path, polling through to completion, 400/404/422 paths (no raw value in body or logs), chunking (heading paths, size budget, token integrity, fences, trailing merge), idempotent retries, the raw-PII refusal, Voyage failure propagation, the mock's determinism/similarity/contextualization/rerank, and the live client's request shape, ordering, windowing and error handling (via injected `fetch`). Mutation check: disabling the worker's PII re-check fails its test. `pnpm --filter @aegis/api test && pnpm turbo run typecheck` and `pnpm turbo run test` pass clean (106/106 tests across shared/web/api, 0 type errors). The BullMQ adapter and a live boot were not exercised against real Redis/MongoDB in this environment (no Docker); run `docker compose up -d` before `pnpm --filter @aegis/api start`.
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
