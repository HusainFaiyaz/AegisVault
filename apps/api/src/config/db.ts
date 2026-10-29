import { MongoClient, type Db } from "mongodb";
import type { Logger } from "pino";

/**
 * Single shared MongoDB connection for the process. The client is created
 * lazily by `connectDb()` at server boot; route handlers obtain the database
 * through `getDb()`. Nothing here runs at import time, so the app (and the
 * PII guard in front of it) can be exercised without a live database.
 */
let client: MongoClient | null = null;
let database: Db | null = null;

export async function connectDb(uri: string, logger: Logger): Promise<Db> {
  if (database) {
    return database;
  }

  const nextClient = new MongoClient(uri, {
    appName: "aegisvault-api",
    serverSelectionTimeoutMS: 5_000,
  });
  await nextClient.connect();

  client = nextClient;
  database = nextClient.db();
  logger.info({ db: database.databaseName }, "mongodb connected");
  return database;
}

export function getDb(): Db {
  if (!database) {
    throw new Error("MongoDB is not connected; call connectDb() first");
  }
  return database;
}

/** Readiness probe: true only when a round-trip `ping` succeeds. */
export async function pingDb(): Promise<boolean> {
  if (!database) {
    return false;
  }
  try {
    await database.command({ ping: 1 });
    return true;
  } catch {
    return false;
  }
}

export async function disconnectDb(): Promise<void> {
  if (client) {
    await client.close();
  }
  client = null;
  database = null;
}
