import { Writable } from "node:stream";
import type { Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, createLogger, TRACE_HEADER } from "../app.js";
import { scanForRawPii } from "../middleware/pii-guard.middleware.js";

/**
 * Stand-ins for the downstream side effects Days 6-8 will add. The guard is
 * proven correct when these are never invoked for a leaking request.
 */
const dbInsert = vi.fn<(doc: unknown) => void>();
const llmCall = vi.fn<(prompt: unknown) => void>();
const checkDb = vi.fn<() => Promise<boolean>>();

let logLines: string[] = [];
let app: Express;

function buildApp(): Express {
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      logLines.push(chunk.toString());
      callback();
    },
  });

  return createApp({
    env: { CORS_ORIGINS: ["http://localhost:5173"], BODY_LIMIT: "1mb" },
    logger: createLogger({ LOG_LEVEL: "info", NODE_ENV: "test" }, sink),
    checkDb,
    registerApiRoutes: (api) => {
      api.post("/probe/documents", (req, res) => {
        dbInsert(req.body);
        res.status(201).json({ stored: true });
      });
      api.post("/probe/chat", (req, res) => {
        llmCall(req.body);
        res.json({ answer: "ok" });
      });
      api.get("/probe/search", (req, res) => {
        dbInsert(req.query);
        res.json({ results: [] });
      });
      api.get("/probe/boom", async () => {
        await Promise.resolve();
        throw new Error("downstream exploded");
      });
    },
  });
}

beforeEach(() => {
  dbInsert.mockReset();
  llmCall.mockReset();
  checkDb.mockReset();
  logLines = [];
  app = buildApp();
});

const RAW_PII_CASES: ReadonlyArray<{ category: string; value: string }> = [
  { category: "SSN", value: "123-45-6789" },
  { category: "MRN", value: "MRN-00482915" },
  { category: "EMAIL", value: "jane.doe@stmarys-hospital.org" },
  { category: "PHONE", value: "(415) 555-0132" },
  { category: "CREDIT_CARD", value: "4111 1111 1111 1111" },
  { category: "IBAN", value: "DE89370400440532013000" },
];

describe("PII ingress guard on /api/v1/*", () => {
  it.each(RAW_PII_CASES)(
    "rejects a raw $category in the body with 422 before any DB or LLM call",
    async ({ category, value }) => {
      const res = await request(app)
        .post("/api/v1/probe/chat")
        .send({ message: `Patient record follows: ${value}. Summarise it.` });

      expect(res.status).toBe(422);
      expect(res.body.error).toBe("ZERO_TRUST_VIOLATION");
      expect(res.body.violations).toEqual(
        expect.arrayContaining([expect.objectContaining({ category, location: "body.message" })]),
      );
      expect(llmCall).not.toHaveBeenCalled();
      expect(dbInsert).not.toHaveBeenCalled();
    },
  );

  it("never echoes the raw value in the response or writes it to the logs", async () => {
    const ssn = "123-45-6789";
    const res = await request(app).post("/api/v1/probe/documents").send({ content: ssn });

    expect(res.status).toBe(422);
    expect(res.text).not.toContain(ssn);
    expect(logLines.join("")).not.toContain(ssn);
    expect(logLines.join("")).toContain("zero_trust_violation");
  });

  it("passes a fully redacted payload with placeholder tokens through to the route", async () => {
    const payload = {
      title: "Discharge summary for [PER_89A1]",
      content: "[PER_89A1] (SSN [SSN_1A2B], [MRN_3F90]) can be reached at [EMAIL_7C21] or [PHONE_04DE].",
      entities: [{ token: "[PER_89A1]", category: "PER" }],
    };

    const res = await request(app).post("/api/v1/probe/documents").send(payload);

    expect(res.status).toBe(201);
    expect(dbInsert).toHaveBeenCalledOnce();
    expect(dbInsert).toHaveBeenCalledWith(payload);
  });

  it("finds PII nested deep inside arrays and objects", async () => {
    const res = await request(app)
      .post("/api/v1/probe/chat")
      .send({ messages: [{ role: "user", content: "fine" }, { role: "user", parts: ["ok", "call 415-555-0132"] }] });

    expect(res.status).toBe(422);
    expect(res.body.violations).toEqual([
      expect.objectContaining({ category: "PHONE", location: "body.messages[1].parts[1]" }),
    ]);
    expect(llmCall).not.toHaveBeenCalled();
  });

  it("scans object keys, not just values", async () => {
    const res = await request(app)
      .post("/api/v1/probe/documents")
      .send({ "jane.doe@stmarys-hospital.org": "[PER_89A1]" });

    expect(res.status).toBe(422);
    expect(res.body.violations[0].category).toBe("EMAIL");
    expect(dbInsert).not.toHaveBeenCalled();
  });

  it("catches a card number smuggled as a JSON number", async () => {
    const res = await request(app)
      .post("/api/v1/probe/documents")
      .set("Content-Type", "application/json")
      .send('{"card": 4111111111111111}');

    expect(res.status).toBe(422);
    expect(res.body.violations[0].category).toBe("CREDIT_CARD");
    expect(dbInsert).not.toHaveBeenCalled();
  });

  it("scans text/plain bodies", async () => {
    const res = await request(app)
      .post("/api/v1/probe/chat")
      .set("Content-Type", "text/plain")
      .send("SSN on file: 123-45-6789");

    expect(res.status).toBe(422);
    expect(res.body.violations[0]).toMatchObject({ category: "SSN", location: "body" });
    expect(llmCall).not.toHaveBeenCalled();
  });

  it("scans the query string and masks it in the request log", async () => {
    const res = await request(app)
      .get("/api/v1/probe/search")
      .query({ q: "jane.doe@stmarys-hospital.org" });

    expect(res.status).toBe(422);
    expect(res.body.violations[0]).toMatchObject({ category: "EMAIL", location: "query.q" });
    expect(dbInsert).not.toHaveBeenCalled();
    expect(logLines.join("")).not.toContain("stmarys-hospital");
  });

  it("scans the URL path", async () => {
    const res = await request(app).get("/api/v1/patients/123-45-6789");

    expect(res.status).toBe(422);
    expect(res.body.violations[0]).toMatchObject({ category: "SSN", location: "path" });
  });

  it("fails closed with 415 on a body it cannot parse and scan", async () => {
    const res = await request(app)
      .post("/api/v1/probe/documents")
      .set("Content-Type", "application/octet-stream")
      .send(Buffer.from("SSN 123-45-6789"));

    expect(res.status).toBe(415);
    expect(res.body.error).toBe("UNSUPPORTED_MEDIA_TYPE");
    expect(dbInsert).not.toHaveBeenCalled();
  });

  it("answers malformed JSON with 400 without quoting the body back", async () => {
    const res = await request(app)
      .post("/api/v1/probe/documents")
      .set("Content-Type", "application/json")
      .send('{"ssn": "123-45-6789"');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("MALFORMED_BODY");
    expect(res.text).not.toContain("123-45-6789");
    expect(logLines.join("")).not.toContain("123-45-6789");
    expect(dbInsert).not.toHaveBeenCalled();
  });

  it("rejects bodies over the configured limit with 413", async () => {
    const res = await request(app)
      .post("/api/v1/probe/documents")
      .send({ content: "a".repeat(1_100_000) });

    expect(res.status).toBe(413);
    expect(res.body.error).toBe("PAYLOAD_TOO_LARGE");
    expect(dbInsert).not.toHaveBeenCalled();
  });
});

describe("gateway plumbing", () => {
  it("assigns a UUID trace id and returns it in the response and 422 body", async () => {
    const res = await request(app).post("/api/v1/probe/chat").send({ q: "123-45-6789" });

    const traceId = res.headers[TRACE_HEADER];
    expect(traceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.traceId).toBe(traceId);
  });

  it("propagates a caller-supplied UUID trace id", async () => {
    const incoming = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
    const res = await request(app).get("/api/v1/health").set(TRACE_HEADER, incoming);

    expect(res.headers[TRACE_HEADER]).toBe(incoming);
  });

  it("replaces a non-UUID trace id so it cannot carry PII into the logs", async () => {
    const res = await request(app).get("/api/v1/health").set(TRACE_HEADER, "123-45-6789");

    expect(res.headers[TRACE_HEADER]).not.toBe("123-45-6789");
    expect(logLines.join("")).not.toContain("123-45-6789");
  });

  it("serves liveness without touching the database", async () => {
    const res = await request(app).get("/api/v1/health");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(checkDb).not.toHaveBeenCalled();
  });

  it("reports readiness from the database ping", async () => {
    checkDb.mockResolvedValueOnce(true);
    const up = await request(app).get("/api/v1/health/ready");
    expect(up.status).toBe(200);
    expect(up.body.checks.mongodb).toBe("up");

    checkDb.mockResolvedValueOnce(false);
    const down = await request(app).get("/api/v1/health/ready");
    expect(down.status).toBe(503);
    expect(down.body.status).toBe("unavailable");
  });

  it("sets helmet security headers and allows the configured CORS origin", async () => {
    const res = await request(app).get("/api/v1/health").set("Origin", "http://localhost:5173");

    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-powered-by"]).toBeUndefined();
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
  });

  it("does not grant CORS to unknown origins", async () => {
    const res = await request(app).get("/api/v1/health").set("Origin", "https://evil.example");

    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("routes async handler rejections to the JSON error handler (Express 5)", async () => {
    const res = await request(app).get("/api/v1/probe/boom");

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: "INTERNAL_SERVER_ERROR" });
    expect(res.text).not.toContain("downstream exploded");
  });

  it("returns JSON 404 for unknown routes", async () => {
    const res = await request(app).get("/api/v1/does-not-exist");

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("NOT_FOUND");
  });
});

describe("scanForRawPii", () => {
  it("returns locations and offsets but never the matched value", () => {
    const violations = scanForRawPii({ a: { b: ["x", "SSN 123-45-6789"] } }, "body");

    expect(violations).toEqual([{ category: "SSN", location: "body.a.b[1]", index: 4 }]);
    expect(JSON.stringify(violations)).not.toContain("123-45-6789");
  });

  it("ignores null, booleans, and placeholder tokens", () => {
    expect(scanForRawPii({ a: null, b: true, c: "[SSN_1A2B] [CREDIT_CARD_FFFF]" }, "body")).toEqual([]);
  });
});
