import { createApp, createLogger } from "./app.js";
import { loadEnv } from "./config/env.js";
import { connectDb, disconnectDb, pingDb } from "./config/db.js";

const SHUTDOWN_TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger(env);

  await connectDb(env.MONGODB_URI, logger);

  const app = createApp({ env, logger, checkDb: pingDb });
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
      void disconnectDb().finally(() => process.exit(0));
    });
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((error: unknown) => {
  console.error("apps/api failed to start", error);
  process.exit(1);
});
