import { Redis } from "ioredis";
import { createApp, createLogger } from "./app.js";
import { loadEnv } from "./config/env.js";
import { connectDb, disconnectDb, pingDb } from "./config/db.js";
import {
  createDocumentChunkStore,
  ensureDocumentChunkIndexes,
  getDocumentChunkCollection,
} from "./models/document-chunk.model.js";
import { createRedisTokenBucketStore, rateLimit } from "./middleware/rate-limit.middleware.js";
import { createChatRouter } from "./routes/chat.routes.js";
import { createDocumentsRouter } from "./routes/documents.routes.js";
import { createChatModel } from "./services/llm.service.js";
import { createCollectionAggregator, createRetrievalService } from "./services/retrieval.service.js";
import { createVoyageService } from "./services/voyage.service.js";
import { createBullIngestionQueue, createIngestionWorker } from "./workers/ingestion.worker.js";

const SHUTDOWN_TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger(env);

  const db = await connectDb(env.MONGODB_URI, logger);
  const chunks = getDocumentChunkCollection(db);
  await ensureDocumentChunkIndexes(chunks);

  // BullMQ workers require `maxRetriesPerRequest: null` on their connection.
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const voyage = createVoyageService({ apiKey: env.VOYAGE_API_KEY });
  logger.info({ voyageMode: voyage.mode, model: voyage.embeddingModel }, "voyage client ready");

  const ingestionQueue = createBullIngestionQueue(redis);
  const ingestionWorker = createIngestionWorker({
    connection: redis,
    deps: { voyage, chunkStore: createDocumentChunkStore(chunks) },
    logger,
    concurrency: env.INGESTION_CONCURRENCY,
  });

  const retrieval = createRetrievalService({ aggregator: createCollectionAggregator(chunks), voyage });
  const chatModel = createChatModel({ apiKey: env.AI_PROVIDER_API_KEY, modelId: env.AI_MODEL });
  logger.info({ llmMode: chatModel.mode, model: chatModel.modelId }, "chat model ready");

  // Separate connection that fails fast: a Redis outage must not stall chat
  // requests behind BullMQ's infinite-retry connection settings.
  const rateLimitRedis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
  rateLimitRedis.on("error", (err) => logger.warn({ errName: err.name }, "rate-limit redis error"));
  const chatRateLimiter = rateLimit({
    name: "chat",
    store: createRedisTokenBucketStore(rateLimitRedis),
    capacity: env.CHAT_RATE_LIMIT_CAPACITY,
    refillPerSecond: env.CHAT_RATE_LIMIT_REFILL_PER_MINUTE / 60,
  });

  const app = createApp({
    env,
    logger,
    checkDb: pingDb,
    registerApiRoutes: (api) => {
      api.use(createDocumentsRouter({ queue: ingestionQueue }));
      api.use(
        createChatRouter({
          retrieval,
          model: chatModel.model,
          modelId: chatModel.modelId,
          rateLimiter: chatRateLimiter,
          maxOutputTokens: env.CHAT_MAX_OUTPUT_TOKENS,
        }),
      );
    },
  });
  const server = app.listen(env.PORT, (error?: Error) => {
    if (error) {
      logger.fatal({ err: error }, "failed to bind http server");
      process.exit(1);
    }
    logger.info({ port: env.PORT }, "aegisvault api listening");
  });

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, "shutting down");

    const forceExit = setTimeout(() => {
      logger.error("graceful shutdown timed out; forcing exit");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    server.close(() => {
      // Let in-flight jobs finish before closing the connections they use.
      void ingestionWorker
        .close()
        .then(() => ingestionQueue.close())
        .then(() => rateLimitRedis.quit())
        .then(() => redis.quit())
        .then(() => disconnectDb())
        .finally(() => process.exit(0));
    });
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((error: unknown) => {
  console.error("apps/api failed to start", error);
  process.exit(1);
});
