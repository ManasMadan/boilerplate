/**
 * Entry point for better-auth's CLI (`auth generate`), which reads the configuration to
 * produce the auth tables. It builds the real configuration with inert dependencies:
 * nothing connects to Postgres or Redis and nothing is sent.
 * Used by the db-change skill: `bun run auth:schema`.
 */

import { unlimited } from "@repo/contracts/billing";
import { createDb } from "@repo/db";
import type { Producer } from "@repo/jobs";
import { Redis } from "ioredis";
import { env } from "../env";
import { createAuth } from "./auth";
import { createMemberships } from "./memberships";

const notifications = {
  add: () => Promise.reject(new Error("The auth CLI never sends notifications")),
} as unknown as Producer<"notifications-critical">;

const db = createDb({ url: env.API_DATABASE_URL, poolMax: 1, service: "auth-cli" });
const redis = new Redis(env.REDIS_URL, { lazyConnect: true });

export const auth = createAuth({
  env,
  db,
  redis,
  notifications,
  memberships: createMemberships(db, redis),
  billing: {
    entitlements: async () => unlimited,
    cancelFor: () => Promise.reject(new Error("The auth CLI never changes billing")),
  },
});
