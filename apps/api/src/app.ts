import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import cors from "cors";
import express, {
  Router,
  type ErrorRequestHandler,
  type Express,
  type RequestHandler,
} from "express";
import helmet from "helmet";
import { pino, type DestinationStream, type Logger } from "pino";
import { pinoHttp } from "pino-http";
import { detectRawPiiLeakage } from "@aegis/shared";
import type { Env } from "./config/env.js";
import { piiGuard } from "./middleware/pii-guard.middleware.js";
import { createHealthRouter } from "./routes/health.routes.js";

export const TRACE_HEADER = "x-request-id";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createLogger(
  env: Pick<Env, "LOG_LEVEL" | "NODE_ENV">,
  destination?: DestinationStream,
): Logger {
  const options = {
    level: env.LOG_LEVEL,
    base: { service: "aegisvault-api", env: env.NODE_ENV },
    redact: {
      paths: ["req.headers.authorization", "req.headers.cookie", "res.headers['set-cookie']"],
      censor: "[REDACTED]",
    },
  };
  return destination ? pino(options, destination) : pino(options);
}

/**
 * Request URLs are logged on every request, including the ones the PII guard
 * is about to reject, so any raw PII in the path or query string is masked
 * before it reaches the log stream.
 */
function maskUrl(url: string | undefined): string | undefined {
  if (url === undefined) {
    return undefined;
  }
  let decoded = url;
  try {
    decoded = decodeURIComponent(url);
  } catch {
    // Malformed escapes: scan the raw form instead.
  }
  const findings = detectRawPiiLeakage(decoded).sort((a, b) => b.index - a.index);
  let masked = decoded;
  for (const { index, match } of findings) {
    masked = `${masked.slice(0, index)}[REDACTED]${masked.slice(index + match.length)}`;
  }
  return masked;
}

/**
 * Reuses a caller-supplied `x-request-id` only when it is a UUID, so the
 * header cannot be used to smuggle arbitrary text (or PII) into the logs.
 */
function resolveTraceId(req: IncomingMessage, res: ServerResponse): string {
  const incoming = req.headers[TRACE_HEADER];
  const traceId =
    typeof incoming === "string" && UUID_PATTERN.test(incoming) ? incoming : randomUUID();
  res.setHeader(TRACE_HEADER, traceId);
  return traceId;
}

const exposeTraceId: RequestHandler = (req, res, next) => {
  res.locals.traceId = String(req.id);
  next();
};

const notFound: RequestHandler = (_req, res) => {
  res.status(404).json({ error: "NOT_FOUND", traceId: res.locals.traceId as string });
};

interface HttpError extends Error {
  status?: number;
  statusCode?: number;
  type?: string;
  expose?: boolean;
}

/**
 * Central error handler. Express 5 forwards rejected promises from async
 * handlers here natively. Error messages are never echoed for body-parser
 * failures because Node's JSON parse errors quote fragments of the raw body.
 */
const errorHandler: ErrorRequestHandler = (err: HttpError, req, res, _next) => {
  const status = err.status ?? err.statusCode ?? 500;
  const traceId = res.locals.traceId as string | undefined;

  if (status < 500) {
    req.log.warn({ errType: err.type, status }, "client error");
    const error =
      err.type === "entity.parse.failed"
        ? "MALFORMED_BODY"
        : err.type === "entity.too.large"
          ? "PAYLOAD_TOO_LARGE"
          : "BAD_REQUEST";
    res.status(status).json({ error, traceId });
    return;
  }

  req.log.error({ err }, "unhandled error");
  res.status(500).json({ error: "INTERNAL_SERVER_ERROR", traceId });
};

export interface CreateAppOptions {
  env: Pick<Env, "CORS_ORIGINS" | "BODY_LIMIT">;
  logger: Logger;
  checkDb: () => Promise<boolean>;
  /**
   * Mounts feature routers on the `/api/v1` router. Everything registered
   * here sits behind the PII guard, so it only ever sees redacted payloads.
   */
  registerApiRoutes?: (api: Router) => void;
}

export function createApp({
  env,
  logger,
  checkDb,
  registerApiRoutes,
}: CreateAppOptions): Express {
  const app = express();

  app.disable("x-powered-by");
  app.use(
    pinoHttp({
      logger,
      genReqId: resolveTraceId,
      customProps: (req) => ({ traceId: req.id }),
      serializers: {
        req: (req: { id: unknown; method: string; url?: string }) => ({
          id: req.id,
          method: req.method,
          url: maskUrl(req.url),
        }),
      },
    }),
  );
  app.use(exposeTraceId);
  app.use(helmet());
  app.use(
    cors({
      origin: env.CORS_ORIGINS,
      exposedHeaders: [TRACE_HEADER],
    }),
  );
  app.use(express.json({ limit: env.BODY_LIMIT }));
  app.use(express.text({ limit: env.BODY_LIMIT, type: "text/plain" }));

  const api = Router();
  api.use(piiGuard());
  api.use(createHealthRouter({ checkDb }));
  registerApiRoutes?.(api);

  app.use("/api/v1", api);
  app.use(notFound);
  app.use(errorHandler);

  return app;
}
