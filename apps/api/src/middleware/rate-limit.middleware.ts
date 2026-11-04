import { createHash } from "node:crypto";
import type { Request, RequestHandler } from "express";

/**
 * Token-bucket rate limiting backed by Redis.
 *
 * Each client gets a bucket of `capacity` tokens that refills continuously at
 * `refillPerSecond`. A request spends `cost` tokens or is rejected with 429
 * and a `Retry-After` that says exactly when enough tokens will be back.
 * The read-refill-spend-write cycle runs as one Lua script, so concurrent API
 * instances can never double-spend a bucket.
 */

export interface TokenBucketPolicy {
  capacity: number;
  refillPerSecond: number;
}

export interface TakeResult {
  allowed: boolean;
  /** Whole tokens left after this request. */
  remaining: number;
  /** 0 when allowed; otherwise how long until `cost` tokens are available. */
  retryAfterMs: number;
}

export interface TokenBucketStore {
  take(key: string, policy: TokenBucketPolicy, cost: number): Promise<TakeResult>;
}

/**
 * KEYS[1] bucket hash; ARGV: capacity, refill per ms, cost, now in ms
 * (0 = use the Redis server clock, so every API instance shares one clock),
 * TTL in ms. Returns {allowed, tokens (string, keeps the fraction), retryMs}.
 */
export const TOKEN_BUCKET_LUA = `
local capacity = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local now = tonumber(ARGV[4])
local ttl = tonumber(ARGV[5])
if now == nil or now <= 0 then
  local t = redis.call('TIME')
  now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
end
local state = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(state[1])
local ts = tonumber(state[2])
if tokens == nil or ts == nil then
  tokens = capacity
  ts = now
end
if now > ts then
  tokens = math.min(capacity, tokens + (now - ts) * refill)
  ts = now
end
local allowed = 0
local retry = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  retry = math.ceil((cost - tokens) / refill)
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', tostring(ts))
redis.call('PEXPIRE', KEYS[1], ttl)
return {allowed, tostring(tokens), retry}
`;

/** The one Redis command the store needs; satisfied by `ioredis`. */
export interface RedisScriptRunner {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

function validatePolicy(policy: TokenBucketPolicy, cost: number): void {
  if (!(policy.capacity > 0) || !(policy.refillPerSecond > 0) || !(cost > 0) || cost > policy.capacity) {
    throw new RangeError("token bucket needs capacity > 0, refillPerSecond > 0 and 0 < cost <= capacity");
  }
}

/** Long enough for an idle bucket to refill completely, then it expires. */
function bucketTtlMs(policy: TokenBucketPolicy): number {
  return Math.ceil((policy.capacity / policy.refillPerSecond) * 1000) + 1_000;
}

export function createRedisTokenBucketStore(
  redis: RedisScriptRunner,
  options: { now?: () => number } = {},
): TokenBucketStore {
  return {
    async take(key, policy, cost) {
      validatePolicy(policy, cost);
      const reply = await redis.eval(
        TOKEN_BUCKET_LUA,
        1,
        key,
        policy.capacity,
        policy.refillPerSecond / 1000,
        cost,
        options.now?.() ?? 0,
        bucketTtlMs(policy),
      );
      if (!Array.isArray(reply) || reply.length !== 3) {
        throw new Error("unexpected token bucket reply from Redis");
      }
      const [allowed, tokens, retry] = reply as [unknown, unknown, unknown];
      return {
        allowed: Number(allowed) === 1,
        remaining: Math.max(0, Math.floor(Number(tokens))),
        retryAfterMs: Math.max(0, Number(retry)),
      };
    },
  };
}

/** Single-process store with the same semantics, for tests and Redis-less dev. */
export function createInMemoryTokenBucketStore(now: () => number = Date.now): TokenBucketStore {
  const buckets = new Map<string, { tokens: number; ts: number }>();
  return {
    async take(key, policy, cost) {
      validatePolicy(policy, cost);
      const at = now();
      const refillPerMs = policy.refillPerSecond / 1000;
      const bucket = buckets.get(key) ?? { tokens: policy.capacity, ts: at };
      if (at > bucket.ts) {
        bucket.tokens = Math.min(policy.capacity, bucket.tokens + (at - bucket.ts) * refillPerMs);
        bucket.ts = at;
      }
      let allowed = false;
      let retryAfterMs = 0;
      if (bucket.tokens >= cost) {
        bucket.tokens -= cost;
        allowed = true;
      } else {
        retryAfterMs = Math.ceil((cost - bucket.tokens) / refillPerMs);
      }
      buckets.set(key, bucket);
      return { allowed, remaining: Math.max(0, Math.floor(bucket.tokens)), retryAfterMs };
    },
  };
}

export interface RateLimitOptions extends TokenBucketPolicy {
  store: TokenBucketStore;
  /** Namespace for the bucket keys, e.g. `chat`. */
  name: string;
  cost?: number;
  /** Identifies the caller; defaults to the client IP. */
  identify?: (req: Request) => string;
  /**
   * When the store is unreachable: `true` lets the request through with a
   * warning (availability), `false` answers 503 (strict cost control).
   */
  failOpen?: boolean;
}

export const RATE_LIMIT_KEY_PREFIX = "aegis:ratelimit";

/**
 * The caller identity is hashed before it becomes a Redis key, so client
 * IPs are never stored in Redis in the clear.
 */
export function rateLimitKey(name: string, identity: string): string {
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 32);
  return `${RATE_LIMIT_KEY_PREFIX}:${name}:${digest}`;
}

export function rateLimit(options: RateLimitOptions): RequestHandler {
  const cost = options.cost ?? 1;
  const policy: TokenBucketPolicy = { capacity: options.capacity, refillPerSecond: options.refillPerSecond };
  validatePolicy(policy, cost);
  const identify = options.identify ?? ((req: Request) => req.ip ?? req.socket.remoteAddress ?? "unknown");
  const failOpen = options.failOpen ?? true;
  const windowSeconds = Math.ceil(options.capacity / options.refillPerSecond);

  return async (req, res, next) => {
    let result: TakeResult;
    try {
      result = await options.store.take(rateLimitKey(options.name, identify(req)), policy, cost);
    } catch (err) {
      req.log.warn({ errName: err instanceof Error ? err.name : "unknown", limiter: options.name, failOpen }, "rate limiter unavailable");
      if (failOpen) {
        next();
        return;
      }
      res.status(503).json({ error: "RATE_LIMITER_UNAVAILABLE", traceId: res.locals.traceId as string });
      return;
    }

    res.setHeader("RateLimit-Limit", String(options.capacity));
    res.setHeader("RateLimit-Remaining", String(result.remaining));
    res.setHeader("RateLimit-Policy", `${options.capacity};w=${windowSeconds}`);

    if (!result.allowed) {
      const retryAfterSeconds = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
      res.setHeader("Retry-After", String(retryAfterSeconds));
      req.log.info({ limiter: options.name, retryAfterMs: result.retryAfterMs }, "rate limited");
      res.status(429).json({
        error: "RATE_LIMITED",
        retryAfterMs: result.retryAfterMs,
        traceId: res.locals.traceId as string,
      });
      return;
    }
    next();
  };
}
