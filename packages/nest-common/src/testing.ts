/**
 * Helpers for integration tests (not part of the runtime surface).
 */

/**
 * The local Redis/Valkey at REDIS_URL, but a specific logical database, so a test
 * suite never shares queues or sessions with the dev stack or another suite. Every
 * number is taken; docs/testing.md lists who has which.
 */
export function redisDatabase(index: number): string {
  const url = new URL(process.env.REDIS_URL ?? "redis://localhost:56379");
  url.pathname = `/${index}`;
  return url.toString();
}
