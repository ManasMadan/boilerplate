/**
 * Boots the real API in-process against an isolated database (cloned from the migrated
 * template) and its own Redis database index, and gives tests a typed oRPC client plus a
 * cookie-aware HTTP helper for better-auth endpoints.
 */
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import type { Contract } from "@repo/contracts/api";
import { createTestDatabase, type TestDatabase } from "@repo/db/testing";
import { type NotificationPayload, parseJob, queuePrefix } from "@repo/jobs";
import { redisDatabase } from "@repo/nest-common/testing";
import { Queue } from "bullmq";
import { Redis } from "ioredis";

export interface Harness {
  baseUrl: string;
  redis: Redis;
  testDb: TestDatabase;
  close(): Promise<void>;
}

export async function startApi(env: Record<string, string> = {}): Promise<Harness> {
  const testDb = await createTestDatabase();
  Object.assign(process.env, {
    API_DATABASE_URL: testDb.urlFor("app_api"),
    // A private Redis database: queued jobs and sessions never mix with local dev.
    REDIS_URL: redisDatabase(13),
    ...env,
  });
  const redis = new Redis(process.env.REDIS_URL as string, { maxRetriesPerRequest: null });
  await redis.flushdb();
  const { createApiServer } = await import("../src/server");
  const app: NestFastifyApplication = await createApiServer();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.getHttpServer().address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    redis,
    testDb,
    async close() {
      await app.close();
      await redis.quit();
      await testDb.drop();
    },
  };
}

/** A browser-like session: cookies, origin and a unique client IP (rate limits are per IP). */
export function createSession(
  harness: Harness,
  options: { locale?: string; appVersion?: string } = {},
) {
  let cookies = new Map<string, string>();
  const ip = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  const headers = () => ({
    origin: process.env.WEB_URL ?? "http://localhost:3000",
    "x-forwarded-for": ip,
    ...(options.locale && { "accept-language": options.locale }),
    ...(options.appVersion && { "x-app-version": options.appVersion }),
    ...(cookies.size && {
      cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join("; "),
    }),
  });
  const store = (response: Response) => {
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(";");
      const [name, ...rest] = (pair ?? "").split("=");
      if (!name) continue;
      const value = rest.join("=");
      if (value === "" || /max-age=0/i.test(cookie)) cookies.delete(name);
      else cookies.set(name, value);
    }
  };

  return {
    ip,
    async auth<T = unknown>(path: string, body: unknown = {}) {
      const response = await fetch(`${harness.baseUrl}/api/auth${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers() },
        body: JSON.stringify(body),
      });
      store(response);
      return { status: response.status, body: (await response.json().catch(() => null)) as T };
    },
    async authGet<T = unknown>(path: string): Promise<T> {
      const response = await fetch(`${harness.baseUrl}/api/auth${path}`, { headers: headers() });
      store(response);
      return (await response.json()) as T;
    },
    rpc: createORPCClient<ContractRouterClient<Contract>>(
      new RPCLink({
        url: `${harness.baseUrl}/rpc`,
        headers,
        fetch: async (request, init) => {
          const response = await fetch(request, init);
          store(response);
          return response;
        },
      }),
    ),
    cookies: () => new Map(cookies),
    useCookies: (next: Map<string, string>) => {
      cookies = new Map(next);
    },
  };
}

/**
 * Takes the first queued notification matching `match` (no worker runs in these tests),
 * waiting up to 5 seconds for it to be enqueued.
 */
export async function takeNotification<T extends NotificationPayload["template"]>(
  harness: Harness,
  template: T,
  email: string,
): Promise<Extract<NotificationPayload, { template: T }>> {
  const queue = new Queue("notifications-critical", {
    connection: harness.redis,
    prefix: queuePrefix("notifications-critical"),
  });
  try {
    for (let attempt = 0; attempt < 50; attempt++) {
      const jobs = await queue.getJobs(["waiting", "delayed", "prioritized"]);
      for (const job of jobs.reverse()) {
        const { payload } = parseJob("notifications-critical", "send", job.data);
        if (payload.template === template && "email" in payload.to && payload.to.email === email) {
          await job.remove();
          return payload as Extract<NotificationPayload, { template: T }>;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`No ${template} queued for ${email}`);
  } finally {
    await queue.close();
  }
}

/** Reads the one-time code queued for an email address. */
export async function takeOtp(harness: Harness, email: string) {
  const payload = await takeNotification(harness, "auth.otp", email);
  return { otp: payload.data.otp, locale: payload.to.locale, purpose: payload.data.purpose };
}

export const newEmail = () => `user-${randomUUID()}@test.dev`;
export const newPassword = () => `Pw-${randomUUID()}`;
