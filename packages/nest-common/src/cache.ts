/**
 * Cache-aside on Redis.
 *
 *   const plan = await cache.wrap(`org:${orgId}:plan`, 300, () => billing.loadPlan(orgId));
 *   await cache.invalidate(`org:${orgId}:plan`);   // e.g. from a billing.plan_changed event
 *
 * - Concurrent misses in one process share one load (no stampede on a cold key).
 * - TTLs get ±10% jitter so keys written together don't all expire together.
 * - Keys are versioned (`CACHE_VERSION`): bump it when a cached shape changes and old
 *   entries are simply never read again.
 * - Values are JSON; cache only what serializes losslessly (no Dates, Maps, classes).
 *
 * Tenant data must include the org id in the key; a cache is not protected by
 * row-level security.
 */
import type { Redis } from "ioredis";

const CACHE_VERSION = "v1";

export class CacheService {
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly redis: Redis,
    private readonly namespace: string,
  ) {}

  private key(key: string) {
    return `cache:${this.namespace}:${CACHE_VERSION}:${key}`;
  }

  async get<T>(key: string): Promise<T | undefined> {
    const raw = await this.redis.get(this.key(key));
    return raw === null ? undefined : (JSON.parse(raw) as T);
  }

  async set(key: string, value: unknown, ttlSeconds: number) {
    const jittered = Math.max(1, Math.round(ttlSeconds * (0.9 + Math.random() * 0.2)));
    await this.redis.set(this.key(key), JSON.stringify(value), "EX", jittered);
  }

  async wrap<T>(key: string, ttlSeconds: number, load: () => Promise<T>): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== undefined) return cached;

    const pending = this.inflight.get(key) as Promise<T> | undefined;
    if (pending !== undefined) return pending;

    const loading = load()
      .then(async (value) => {
        await this.set(key, value, ttlSeconds);
        return value;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, loading);
    return loading;
  }

  async invalidate(key: string) {
    await this.redis.del(this.key(key));
  }
}
