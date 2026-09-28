/**
 * Rate limiting on Redis, shared by every replica.
 *
 *   const limiter = createRateLimiter(redis, { name: "sign-in", points: 5, windowSeconds: 60 });
 *   const result = await limiter.consume(`${ip}:${email}`);
 *   if (!result.allowed) throw new AppError("RATE_LIMITED", { params: { retryAfterSeconds } });
 *
 * Keys are hashed into one Redis Cluster slot per limiter (`{rl:<name>}`) so the limiter
 * keeps working unchanged on a cluster. When Redis is unreachable the limiter fails
 * CLOSED for sensitive limiters (auth, AI) and OPEN for general traffic, per `onRedisError`:
 * an outage should not lock everyone out, nor open the door to credential stuffing.
 */
import type { Redis } from "ioredis";
import { RateLimiterRedis, RateLimiterRes } from "rate-limiter-flexible";

export interface RateLimiterOptions {
  name: string;
  points: number;
  windowSeconds: number;
  /** What to do if Redis is down: "deny" for auth/AI, "allow" for general traffic. */
  onRedisError?: "deny" | "allow";
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export function createRateLimiter(redis: Redis, options: RateLimiterOptions) {
  const limiter = new RateLimiterRedis({
    storeClient: redis,
    keyPrefix: `{rl:${options.name}}`,
    points: options.points,
    duration: options.windowSeconds,
  });
  const failOpen = options.onRedisError === "allow";

  return {
    async consume(key: string, cost = 1): Promise<RateLimitResult> {
      try {
        const res = await limiter.consume(key, cost);
        return { allowed: true, remaining: res.remainingPoints, retryAfterSeconds: 0 };
      } catch (error) {
        if (error instanceof RateLimiterRes) {
          return {
            allowed: false,
            remaining: 0,
            retryAfterSeconds: Math.ceil(error.msBeforeNext / 1000),
          };
        }
        if (failOpen) return { allowed: true, remaining: 0, retryAfterSeconds: 0 };
        return { allowed: false, remaining: 0, retryAfterSeconds: options.windowSeconds };
      }
    },
    reset: (key: string) => limiter.delete(key),
  };
}

export type RateLimiter = ReturnType<typeof createRateLimiter>;
