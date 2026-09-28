/**
 * Integration test: a real queue (Valkey), the real processor and a real SMTP server
 * (Mailpit). Requires `bun run db:up`.
 */
import "reflect-metadata";
import { randomUUID } from "node:crypto";
import type { INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { createDb } from "@repo/db";
import { createTestDatabase, type TestDatabase } from "@repo/db/testing";
import { createProducer, type Producer } from "@repo/jobs";
import { createRedis } from "@repo/nest-common";
import { redisDatabase } from "@repo/nest-common/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const MAILPIT = process.env.MAILPIT_URL ?? "http://localhost:8025";

interface MailpitMessage {
  ID: string;
  Subject: string;
  To: { Address: string }[];
}

async function waitForEmail(to: string, timeoutMs = 15_000): Promise<MailpitMessage> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`);
    const body = (await res.json()) as { messages: MailpitMessage[] };
    if (body.messages[0]) return body.messages[0];
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`No email for ${to} within ${timeoutMs}ms`);
}

describe("notifications service", () => {
  let app: INestApplicationContext;
  let testDb: TestDatabase;
  let producer: Producer<"notifications-critical">;
  let bulk: Producer<"notifications-bulk">;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    // The service connects as its own least-privileged role, exactly as in production.
    process.env.NOTIFICATIONS_DATABASE_URL = testDb.urlFor("app_notifications");
    // A private Redis database, so a notifications service running locally for
    // development can't take this test's jobs (the API tests use 13).
    process.env.REDIS_URL = redisDatabase(14);
    const redis = createRedis(process.env.REDIS_URL);
    await redis.flushdb();
    await redis.quit();
    // Imported after the env is set: env.ts validates at import time.
    const { AppModule } = await import("../src/app.module");
    const { env } = await import("../src/env");
    app = await NestFactory.createApplicationContext(AppModule, { logger: false });
    await app.init();
    producer = createProducer("notifications-critical", createRedis(env.REDIS_URL));
    bulk = createProducer("notifications-bulk", createRedis(env.REDIS_URL));
  });

  afterAll(async () => {
    await producer?.close();
    await bulk?.close();
    await app?.close();
    await testDb?.drop();
  });

  it("delivers a localized OTP email through the queue", async () => {
    const to = `otp-${randomUUID()}@test.dev`;
    await producer.add(
      "send",
      {
        template: "auth.otp",
        to: { email: to, locale: "es" },
        data: { otp: "314159", purpose: "email-verification", expiresInMinutes: 5 },
      },
      { jobId: randomUUID() },
    );

    const message = await waitForEmail(to);
    expect(message.Subject).toBe("Verifica tu correo");

    const full = (await (await fetch(`${MAILPIT}/api/v1/message/${message.ID}`)).json()) as {
      Text: string;
      HTML: string;
    };
    expect(full.Text).toContain("314159");
    expect(full.Text).toContain("Este código caduca en 5 minutos.");
    expect(full.HTML).toContain('lang="es"');
  });

  it("resolves a user recipient from the database and writes in their language", async () => {
    const email = `user-${randomUUID()}@test.dev`;
    // Users are created by the api service, which owns the auth schema.
    const api = createDb({ url: testDb.urlFor("app_api"), poolMax: 1, service: "test" });
    const user = await api.user.create({ data: { name: "Lucía", email, locale: "es" } });
    await api.$disconnect();

    await bulk.add(
      "send",
      {
        template: "todo.reminder",
        to: { userId: user.id },
        data: { todoId: randomUUID(), title: "Llamar al banco" },
      },
      { jobId: randomUUID() },
    );

    const message = await waitForEmail(email);
    expect(message.Subject).toBe("Recordatorio: Llamar al banco");
    const full = (await (await fetch(`${MAILPIT}/api/v1/message/${message.ID}`)).json()) as {
      Text: string;
    };
    expect(full.Text).toContain("Este es tu recordatorio para «Llamar al banco».");
  });

  it("deletes critical jobs as soon as they complete, so one-time codes never linger in Redis", async () => {
    const jobId = randomUUID();
    const to = `retention-${randomUUID()}@test.dev`;
    await producer.add(
      "send",
      {
        template: "auth.otp",
        to: { email: to, locale: "en" },
        data: { otp: "271828", purpose: "sign-in", expiresInMinutes: 5 },
      },
      { jobId },
    );
    await waitForEmail(to);
    // Give the worker a moment to acknowledge completion after the SMTP send.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await producer.queue.getJob(jobId)).toBeUndefined();
  });

  it("rejects payloads that break the contract before they reach the queue", async () => {
    await expect(
      producer.add(
        "send",
        {
          template: "auth.otp",
          to: { email: "not-an-email", locale: "es" },
          data: { otp: "1", purpose: "email-verification", expiresInMinutes: 5 },
        },
        { jobId: randomUUID() },
      ),
    ).rejects.toThrow();
  });
});
