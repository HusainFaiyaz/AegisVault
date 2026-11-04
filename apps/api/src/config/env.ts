import { z } from "zod";

/**
 * Typed, validated runtime configuration for apps/api. Parsed once at boot so
 * a missing or malformed variable fails fast instead of surfacing mid-request.
 * Defaults mirror the root `.env.example` and docker-compose services.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  /** Comma-separated list of browser origins allowed to call the API. */
  CORS_ORIGINS: z
    .string()
    .default("http://localhost:5173")
    .transform((value) =>
      value
        .split(",")
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    ),
  /** Upper bound for JSON/text request bodies scanned by the PII guard. */
  BODY_LIMIT: z.string().default("1mb"),
  MONGODB_URI: z.string().url().default("mongodb://localhost:27017/aegisvault"),
  REDIS_URL: z.string().url().default("redis://localhost:6379"),
  VOYAGE_API_KEY: z.string().min(1).default("mock"),
  /** Parallel ingestion jobs per worker process. */
  INGESTION_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(2),
  /** Anthropic key for the Vercel AI SDK; empty or "mock" selects the offline mock model. */
  AI_PROVIDER_API_KEY: z.string().default(""),
  AI_MODEL: z.string().min(1).default("claude-opus-5-5"),
  CHAT_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(256).max(128_000).default(16_000),
  /** Token bucket for POST /api/v1/chat/stream: burst size and sustained rate per client. */
  CHAT_RATE_LIMIT_CAPACITY: z.coerce.number().int().min(1).max(1_000).default(20),
  CHAT_RATE_LIMIT_REFILL_PER_MINUTE: z.coerce.number().positive().max(6_000).default(10),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid apps/api environment: ${issues}`);
  }
  return parsed.data;
}
