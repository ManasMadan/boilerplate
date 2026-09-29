/**
 * Helpers for integration tests (not part of the runtime surface).
 */

/**
 * The local Redis/Valkey at REDIS_URL, but a specific logical database, so a test
 * suite never shares queues or sessions with the dev stack or another suite.
 * Numbers in use (Valkey has 0-15; 0 is the dev stack): 11 webhooks, 12 nest-common,
 * 13 api, 14 notifications, 15 worker.
 */
export function redisDatabase(index: number): string {
  const url = new URL(process.env.REDIS_URL ?? "redis://localhost:6379");
  url.pathname = `/${index}`;
  return url.toString();
}
