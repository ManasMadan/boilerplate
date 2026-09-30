/** Integration tests for the Redis-backed helpers. Requires `bun run db:up`. */
import { randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import { Redis } from "ioredis";
import { afterAll, describe, expect, it, vi } from "vitest";
import { CacheService } from "../src/cache";
import { AppError } from "../src/errors";
import { IdempotencyStore } from "../src/idempotency";
import { createRateLimiter } from "../src/rate-limit";
import { redisDatabase } from "../src/testing";

const redis = new Redis(redisDatabase(12), {
  maxRetriesPerRequest: null,
});
afterAll(() => redis.quit());

describe("CacheService", () => {
  it("loads once for concurrent misses, then serves from Redis", async () => {
    const cache = new CacheService(redis, `test-${randomUUID()}`);
    let loads = 0;
    const load = async () => {
      loads += 1;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { plan: "pro" };
    };
    const results = await Promise.all(Array.from({ length: 10 }, () => cache.wrap("k", 60, load)));
    expect(results.every((r) => r.plan === "pro")).toBe(true);
    expect(await cache.wrap("k", 60, load)).toEqual({ plan: "pro" });
    expect(loads).toBe(1);
    await cache.invalidate("k");
    expect(await cache.get("k")).toBeUndefined();
  });
});

describe("rate limiter", () => {
  it("allows the configured number of calls per window, then reports when to retry", async () => {
    const limiter = createRateLimiter(redis, {
      name: `test-${randomUUID()}`,
      points: 3,
      windowSeconds: 60,
    });
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await limiter.consume("ip-1"));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
    expect(results[3]?.retryAfterSeconds).toBeGreaterThan(0);
    expect((await limiter.consume("ip-2")).allowed).toBe(true);
  });

  it("take() throws RATE_LIMITED with when to retry, past the limit", async () => {
    const limiter = createRateLimiter(redis, {
      name: `test-take-${randomUUID()}`,
      points: 1,
      windowSeconds: 60,
    });
    await limiter.take("k");
    const error = await limiter.take("k").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      code: "RATE_LIMITED",
      params: { retryAfterSeconds: expect.any(Number) },
    });
  });

  it("fails closed or open when Redis is unavailable, as configured", async () => {
    const dead = new Redis("redis://localhost:1", {
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false,
    });
    const closed = createRateLimiter(dead, {
      name: "c",
      points: 5,
      windowSeconds: 60,
      onRedisError: "deny",
    });
    const open = createRateLimiter(dead, {
      name: "o",
      points: 5,
      windowSeconds: 60,
      onRedisError: "allow",
    });
    const logged = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    expect((await closed.consume("x")).allowed).toBe(false);
    expect((await open.consume("x")).allowed).toBe(true);
    // Said, not silent, and once per limiter however many requests hit the outage.
    for (let i = 0; i < 5; i++) await closed.consume("x");
    expect(logged).toHaveBeenCalledTimes(2);
    expect(logged).toHaveBeenCalledWith(
      expect.objectContaining({ limiter: "c", failing: "closed" }),
      "rate limiter can't reach Redis",
    );
    logged.mockRestore();
    dead.disconnect();
  });
});

describe("IdempotencyStore", () => {
  it("runs once and replays the stored result for the same key", async () => {
    const store = new IdempotencyStore(redis);
    const key = randomUUID();
    let runs = 0;
    const op = async () => ({ charged: ++runs });
    expect(await store.run(key, op)).toEqual({ charged: 1 });
    expect(await store.run(key, op)).toEqual({ charged: 1 });
    expect(runs).toBe(1);
  });

  it("rejects a concurrent duplicate and allows a retry after a failure", async () => {
    const store = new IdempotencyStore(redis);
    const key = randomUUID();
    const slow = store.run(
      key,
      () => new Promise((resolve) => setTimeout(() => resolve("ok"), 100)),
    );
    await expect(store.run(key, async () => "dup")).rejects.toBeInstanceOf(AppError);
    await slow;

    const failing = randomUUID();
    await expect(store.run(failing, () => Promise.reject(new Error("boom")))).rejects.toThrow(
      "boom",
    );
    expect(await store.run(failing, async () => "second try")).toBe("second try");
  });
});
