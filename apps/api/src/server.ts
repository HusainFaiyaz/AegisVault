import { Redis } from "ioredis";
import { createApp, createLogger } from "./app.js";
import { loadEnv } from "./config/env.js";
import { connectDb, disconnectDb, pingDb } from "./config/db.js";
import {
  createDocumentChunkStore,
  ensureDocumentChunkIndexes,
  getDocumentChunkCollection,
} from "./models/document-chunk.model.js";
import { createDocumentsRouter } from "./routes/documents.routes.js";
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

  const app = createApp({
    env,
    logger,
    checkDb: pingDb,
    registerApiRoutes: (api) => {
      api.use(createDocumentsRouter({ queue: ingestionQueue }));
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
