/**
 * Helpers for integration tests (not part of the runtime surface).
 */

/**
 * The local Redis/Valkey at REDIS_URL, but a specific logical database, so a test
 * suite never shares queues or sessions with the dev stack or another suite.
 * Numbers in use (Valkey has 0-15; 0 is the dev stack): 11 webhooks, 12 nest-common,
 * 13-5 api (one per test file: each starts its own API, whose queue consumers must not
 * take another file's jobs), 14 notifications, 15 worker; apps/ai's pytest uses 6.
 */
export function redisDatabase(index: number): string {
  const url = new URL(process.env.REDIS_URL ?? "redis://localhost:56379");
  url.pathname = `/${index}`;
  return url.toString();
}
