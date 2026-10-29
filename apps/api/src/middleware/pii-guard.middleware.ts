import type { NextFunction, Request, RequestHandler, Response } from "express";
import { detectRawPiiLeakage, type EntityCategory } from "@aegis/shared";

/**
 * Where a raw PII match was found. The matched value itself is deliberately
 * NOT part of this record: echoing it back in the 422 body or writing it to
 * the logs would leak exactly what the guard exists to stop.
 */
export interface PiiGuardViolation {
  category: EntityCategory;
  /** JSONPath-like location, e.g. `body.messages[2].content` or `query.q`. */
  location: string;
  /** Character offset of the match inside the string at `location`. */
  index: number;
}

export interface ZeroTrustViolationResponse {
  error: "ZERO_TRUST_VIOLATION";
  message: string;
  traceId: string | undefined;
  violations: PiiGuardViolation[];
}

interface ScanTarget {
  location: string;
  value: unknown;
}

/**
 * Walks every string reachable from `root` (object keys included) and runs
 * the shared leakage detector over it. Numbers are scanned as their decimal
 * form so a card number sent as a JSON number cannot slip through. Iterative
 * rather than recursive so a deeply nested payload cannot blow the stack.
 */
export function scanForRawPii(root: unknown, rootLocation: string): PiiGuardViolation[] {
  const violations: PiiGuardViolation[] = [];
  const stack: ScanTarget[] = [{ location: rootLocation, value: root }];

  const scanString = (text: string, location: string): void => {
    for (const finding of detectRawPiiLeakage(text)) {
      violations.push({ category: finding.category, location, index: finding.index });
    }
  };

  while (stack.length > 0) {
    const { location, value } = stack.pop() as ScanTarget;

    if (typeof value === "string") {
      scanString(value, location);
    } else if (typeof value === "number" || typeof value === "bigint") {
      scanString(String(value), location);
    } else if (Array.isArray(value)) {
      value.forEach((item: unknown, i) => {
        stack.push({ location: `${location}[${i}]`, value: item });
      });
    } else if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        const childLocation = `${location}.${key}`;
        scanString(key, `${childLocation}<key>`);
        stack.push({ location: childLocation, value: child });
      }
    }
  }

  return violations;
}

function requestCarriesBody(req: Request): boolean {
  const length = req.headers["content-length"];
  return (
    req.headers["transfer-encoding"] !== undefined ||
    (length !== undefined && length !== "0")
  );
}

function safeDecode(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/**
 * Zero-knowledge ingress guard for `/api/v1/*`. Must be mounted after the
 * body parsers and before any route that touches MongoDB, Redis, or an LLM.
 *
 * - Raw SSN / MRN / IBAN / credit card / email / phone anywhere in the body,
 *   query string, or URL path -> `422 ZERO_TRUST_VIOLATION`.
 * - A body the parsers could not decode (unknown content type) cannot be
 *   proven clean, so it is rejected with `415` rather than passed through.
 */
export function piiGuard(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.body === undefined && requestCarriesBody(req)) {
      res.status(415).json({
        error: "UNSUPPORTED_MEDIA_TYPE",
        message:
          "Request body must be application/json or text/plain so it can be scanned for raw PII.",
        traceId: res.locals.traceId as string | undefined,
      });
      return;
    }

    const violations = [
      ...scanForRawPii(safeDecode(req.path), "path"),
      ...scanForRawPii(req.query, "query"),
      ...scanForRawPii(req.body, "body"),
    ];

    if (violations.length === 0) {
      next();
      return;
    }

    req.log.warn(
      {
        event: "zero_trust_violation",
        categories: [...new Set(violations.map((v) => v.category))],
        locations: [...new Set(violations.map((v) => v.location))],
      },
      "rejected request carrying raw PII",
    );

    const body: ZeroTrustViolationResponse = {
      error: "ZERO_TRUST_VIOLATION",
      message:
        "Request contains unredacted PII. Redact it in the browser and send placeholder tokens only.",
      traceId: res.locals.traceId as string | undefined,
      violations,
    };
    res.status(422).json(body);
  };
}
