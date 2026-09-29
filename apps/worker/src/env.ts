/**
 * Validated environment for the worker. Shared variables come from @repo/nest-common's
 * fragments; add new ones here, to .env.example and to docs/environment.md.
 */
import { coreEnv, databaseEnv, directDatabaseEnv, port, redisEnv } from "@repo/nest-common";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

const positive = z.coerce.number().int().positive();

export const env = createEnv({
  server: {
    ...coreEnv,
    ...databaseEnv("WORKER"),
    // LISTEN/NOTIFY needs a direct connection; a transaction-mode pooler drops it.
    ...directDatabaseEnv("WORKER"),
    ...redisEnv,
    // Only serves health checks.
    PORT: port(3002),

    // Outbox events claimed per transaction, and how often to look even without a NOTIFY.
    RELAY_BATCH_SIZE: positive.max(1000).default(100),
    RELAY_POLL_INTERVAL_MS: positive.default(1000),
    AUDIT_CONCURRENCY: positive.default(20),

    // Retention. Published outbox rows are the replay window for new consumers.
    OUTBOX_RETENTION_DAYS: positive.default(7),
    PROCESSED_EVENT_RETENTION_DAYS: positive.default(30),
    AUDIT_RETENTION_MONTHS: positive.default(13),
    // Webhook delivery logs and received provider events.
    WEBHOOK_HISTORY_DAYS: positive.default(30),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
