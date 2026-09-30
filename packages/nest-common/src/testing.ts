/**
 * Helpers for integration tests (not part of the runtime surface).
 */

/**
 * The local Redis/Valkey at REDIS_URL, but a specific logical database, so a test
 * suite never shares queues or sessions with the dev stack or another suite.
 * docs/testing.md lists who has which; scripts/redis-databases.test.ts keeps them apart.
 */
export function redisDatabase(index: number): string {
  // Always set in tests: every vitest config applies .env.example's values.
  const url = new URL(process.env.REDIS_URL as string);
  url.pathname = `/${index}`;
  return url.toString();
}
