/**
 * Entry point for better-auth's CLI (`auth generate`), which reads the configuration to
 * produce the auth tables. It builds the real configuration with inert dependencies:
 * nothing connects to Postgres or Redis and nothing is sent.
 * Used by the db-change skill: `bun run auth:schema`.
 */
import { createDb } from "@repo/db";
import type { Producer } from "@repo/jobs";
import { Redis } from "ioredis";
import { env } from "../env";
import { createAuth } from "./auth";

const notifications = {
  add: () => Promise.reject(new Error("The auth CLI never sends notifications")),
} as unknown as Producer<"notifications-critical">;

export const auth = createAuth({
  env,
  db: createDb({ url: env.API_DATABASE_URL, poolMax: 1, service: "auth-cli" }),
  redis: new Redis(env.REDIS_URL, { lazyConnect: true }),
  notifications,
});
