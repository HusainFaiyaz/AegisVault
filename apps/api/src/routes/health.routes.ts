import { Router } from "express";

export interface HealthRouterOptions {
  /** Readiness check for MongoDB; resolves `true` when a ping succeeds. */
  checkDb: () => Promise<boolean>;
}

/**
 * `GET /health` is a liveness probe (process is up, no dependencies touched).
 * `GET /health/ready` is a readiness probe that pings MongoDB and answers 503
 * while the database is unreachable.
 */
export function createHealthRouter({ checkDb }: HealthRouterOptions): Router {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.json({ status: "ok", uptimeSeconds: Math.round(process.uptime()) });
  });

  router.get("/health/ready", async (_req, res) => {
    const db = await checkDb();
    res.status(db ? 200 : 503).json({
      status: db ? "ready" : "unavailable",
      checks: { mongodb: db ? "up" : "down" },
    });
  });

  return router;
}
