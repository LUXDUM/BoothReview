/**
 * エントリポイント。
 * - 環境変数の読み込みと検証
 * - DB マイグレーション (起動時に適用)
 * - Hono アプリの起動 (@hono/node-server)
 */
import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import pino from "pino";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { parseConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { createDrizzleRepository } from "./db/repo-drizzle.js";
import { createApp } from "./routes/http.js";
import { createRateLimiter } from "./lib/rate-limit.js";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "boothreview-server" },
});

async function main(): Promise<void> {
  const config = parseConfig(process.env);

  const { db, pool } = createDb(config.databaseUrl);
  pool.on("error", (err) => logger.error({ err }, "pg pool error"));
  const repo = createDrizzleRepository(db);
  const limiter = createRateLimiter();

  // 起動時にマイグレーションを適用 (docker-compose の depends_on healthcheck の後)
  const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../drizzle");
  await migrate(db, { migrationsFolder: migrationsDir });
  logger.info({ migrationsDir }, "migrations applied");

  const app = createApp({ config, repo, limiter, logger });

  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    logger.info({ port: info.port }, "server listening");
  });

  const shutdown = async (): Promise<void> => {
    logger.info("shutting down");
    server.close();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((e) => {
  logger.error({ err: e }, "failed to start server");
  process.exit(1);
});
