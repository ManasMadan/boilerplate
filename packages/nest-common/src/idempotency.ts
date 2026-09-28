/**
 * Idempotency for mutations that must not run twice (payments, sends, expensive jobs).
 *
 *   const result = await idempotency.run(`${userId}:${idempotencyKey}`, () => billing.charge(...));
 *
 * The first call runs the operation and stores its result for 24 hours; a retry with
 * the same key (the client lost the response, a proxy retried) gets the stored result
 * without running it again. A duplicate arriving while the first is still running is
 * rejected as a conflict rather than executed concurrently. Failures are not stored,
 * so a failed attempt can be retried with the same key.
 *
 * Keys must be scoped to the caller (user or org) so one tenant cannot replay another's.
 */
import type { Redis } from "ioredis";
import { AppError } from "./errors";

const TTL_SECONDS = 24 * 60 * 60;
const LOCK_SECONDS = 60;

export class IdempotencyStore {
  constructor(private readonly redis: Redis) {}

  private key(key: string) {
    return `idem:${key}`;
  }

  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const redisKey = this.key(key);
    const claimed = await this.redis.set(
      redisKey,
      JSON.stringify({ state: "running" }),
      "EX",
      LOCK_SECONDS,
      "NX",
    );
    if (!claimed) {
      const existing = await this.redis.get(redisKey);
      const record = existing ? (JSON.parse(existing) as { state: string; result?: T }) : undefined;
      if (record?.state === "done") return record.result as T;
      throw new AppError("IDEMPOTENCY_IN_PROGRESS");
    }
    try {
      const result = await operation();
      await this.redis.set(redisKey, JSON.stringify({ state: "done", result }), "EX", TTL_SECONDS);
      return result;
    } catch (error) {
      await this.redis.del(redisKey);
      throw error;
    }
  }
}
