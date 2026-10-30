import { Router } from "express";
import { SanitizedDocumentUploadSchema } from "@aegis/shared";
import type { IngestionQueue } from "../workers/ingestion.worker.js";

export interface DocumentsRouterOptions {
  queue: IngestionQueue;
}

const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Mounted on the `/api/v1` router, behind the PII guard.
 *
 * - `POST /documents` validates the sanitized upload, enqueues an ingestion
 *   job and answers `202 Accepted` with a status URL. No chunking, embedding
 *   or database work happens on the request path.
 * - `GET /documents/jobs/:jobId` reports the job's state for polling.
 */
export function createDocumentsRouter({ queue }: DocumentsRouterOptions): Router {
  const router = Router();

  router.post("/documents", async (req, res) => {
    const parsed = SanitizedDocumentUploadSchema.safeParse(req.body);
    if (!parsed.success) {
      // Paths and codes only: zod messages are safe, but field values are not echoed.
      res.status(400).json({
        error: "VALIDATION_ERROR",
        traceId: res.locals.traceId as string,
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          code: issue.code,
          message: issue.message,
        })),
      });
      return;
    }

    const jobId = await queue.enqueue(parsed.data);
    const statusUrl = `${req.baseUrl}/documents/jobs/${jobId}`;
    res
      .status(202)
      .location(statusUrl)
      .json({
        jobId,
        documentId: parsed.data.documentId,
        state: "queued",
        statusUrl,
        traceId: res.locals.traceId as string,
      });
  });

  router.get("/documents/jobs/:jobId", async (req, res) => {
    const { jobId } = req.params;
    const status = JOB_ID_PATTERN.test(jobId) ? await queue.getStatus(jobId) : null;
    if (!status) {
      res.status(404).json({ error: "JOB_NOT_FOUND", traceId: res.locals.traceId as string });
      return;
    }
    res.json(status);
  });

  return router;
}
