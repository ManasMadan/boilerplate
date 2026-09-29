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
import pg from "pg";
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
    process.env.UNSUBSCRIBE_SECRET ??= "test-unsubscribe-secret-at-least-32-chars";
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

  // ------------------------------------------------------------------ delivery policy

  /** A user created the way apps/api does, plus direct database access for assertions. */
  async function newUser(name = "Ada") {
    const email = `user-${randomUUID()}@test.dev`;
    const api = createDb({ url: testDb.urlFor("app_api"), poolMax: 1, service: "test" });
    const user = await api.user.create({ data: { name, email, locale: "en" } });
    await api.$disconnect();
    return user;
  }

  async function sql<T = Record<string, unknown>>(query: string, params: unknown[] = []) {
    const client = new pg.Client({ connectionString: testDb.urlFor("postgres") });
    await client.connect();
    try {
      return (await client.query(query, params)).rows as T[];
    } finally {
      await client.end();
    }
  }

  async function reminder(userId: string, jobId = randomUUID()) {
    await bulk.add(
      "send",
      {
        template: "todo.reminder",
        to: { userId },
        data: { todoId: randomUUID(), title: "Water the plants" },
      },
      { jobId },
    );
    return jobId;
  }

  async function settle(jobId: string, deliveries: number) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const rows = await sql<{ status: string }>(
        "SELECT status FROM notifications.delivery WHERE idempotency_key LIKE $1 AND status <> 'sending'",
        [`${jobId}:%`],
      );
      if (rows.length >= deliveries) return rows;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error(`deliveries for ${jobId} didn't settle`);
  }

  it("puts a notification in the inbox and emails it with a one-click unsubscribe", async () => {
    const user = await newUser();
    const jobId = await reminder(user.id);
    await settle(jobId, 2);

    const inbox = await sql(
      "SELECT template, data, link FROM notifications.notification WHERE user_id = $1",
      [user.id],
    );
    expect(inbox).toEqual([
      {
        template: "todo.reminder",
        data: expect.objectContaining({ title: "Water the plants" }),
        link: "/dashboard",
      },
    ]);
    const message = await waitForEmail(user.email);
    const headers = (await (
      await fetch(`${MAILPIT}/api/v1/message/${message.ID}/headers`)
    ).json()) as Record<string, string[]>;
    expect(headers["List-Unsubscribe"]?.[0]).toMatch(
      /\/api\/v1\/notifications\/unsubscribe\?token=/,
    );
    expect(headers["List-Unsubscribe-Post"]?.[0]).toBe("List-Unsubscribe=One-Click");
  });

  it("the same job twice delivers once on every channel", async () => {
    const user = await newUser();
    const { Dispatcher } = await import("../src/dispatch/dispatcher");
    const dispatcher = app.get(Dispatcher);
    const payload = {
      template: "todo.reminder" as const,
      to: { userId: user.id },
      data: { todoId: randomUUID(), title: "Only once" },
    };
    const key = randomUUID();
    // As when a job is retried or an event is redelivered.
    await dispatcher.dispatch(payload, key);
    await dispatcher.dispatch(payload, key);
    expect(
      await sql("SELECT id FROM notifications.notification WHERE user_id = $1", [user.id]),
    ).toHaveLength(1);
    await waitForEmail(user.email);
    const search = (await (
      await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${user.email}`)}`)
    ).json()) as { messages: unknown[] };
    expect(search.messages).toHaveLength(1);
  });

  it("respects a turned-off channel, and never turns off security email", async () => {
    const user = await newUser();
    await sql(
      "INSERT INTO notifications.preference (user_id, category, channel, enabled) VALUES ($1, 'activity', 'email', false), ($1, 'security', 'email', false)",
      [user.id],
    );
    const jobId = await reminder(user.id);
    const rows = await settle(jobId, 2);
    expect(rows.map((row) => row.status).sort()).toEqual(["sent", "skipped"]);

    await producer.add(
      "send",
      {
        template: "auth.security-alert",
        to: { email: user.email, locale: "en" },
        data: { event: "password-changed", securityUrl: "http://localhost:3000/settings/security" },
      },
      { jobId: randomUUID() },
    );
    expect((await waitForEmail(user.email)).Subject).toBe("Your password was changed");
  });

  it("never emails a suppressed address", async () => {
    const user = await newUser();
    await sql(
      "INSERT INTO notifications.suppression (channel, address, reason) VALUES ('email', $1, 'bounce')",
      [user.email.toLowerCase()],
    );
    const jobId = await reminder(user.id);
    const rows = await settle(jobId, 2);
    expect(rows.map((row) => row.status).sort()).toEqual(["sent", "suppressed"]);
  });

  it("holds non-urgent email for users on the daily digest", async () => {
    const user = await newUser();
    await sql("INSERT INTO notifications.settings (user_id, daily_digest) VALUES ($1, true)", [
      user.id,
    ]);
    const jobId = await reminder(user.id);
    await settle(jobId, 2);
    const digest = await sql(
      "SELECT template, data FROM notifications.digest_item WHERE user_id = $1",
      [user.id],
    );
    expect(digest).toEqual([
      { template: "todo.reminder", data: expect.objectContaining({ title: "Water the plants" }) },
    ]);
  });

  it("notifies a workspace's owners and admins when its webhook endpoint is disabled", async () => {
    const owner = await newUser("Owner");
    const admin = await newUser("Admin");
    const member = await newUser("Member");
    const orgId = randomUUID();
    await sql("INSERT INTO auth.organization (id, name, slug) VALUES ($1::uuid, 'Org', $1::text)", [
      orgId,
    ]);
    for (const [user, role] of [
      [owner, "owner"],
      [admin, "admin"],
      [member, "member"],
    ] as const) {
      await sql("INSERT INTO auth.member (organization_id, user_id, role) VALUES ($1, $2, $3)", [
        orgId,
        user.id,
        role,
      ]);
    }
    const events = createProducer(
      "events-notifications",
      createRedis(process.env.REDIS_URL as string),
    );
    const endpointId = randomUUID();
    const eventId = randomUUID();
    await events.add(
      "event",
      {
        id: eventId,
        name: "webhook.endpoint_disabled.v1",
        key: endpointId,
        payload: { endpointId, url: "https://example.com/hook", reason: "failing" },
        orgId,
        actorId: null,
        requestId: null,
        occurredAt: new Date().toISOString(),
        source: "webhooks",
      },
      { jobId: eventId },
    );
    await events.close();
    await settle(eventId, 4);
    const notified = await sql<{ user_id: string }>(
      "SELECT user_id FROM notifications.notification WHERE template = 'webhooks.endpoint-disabled' AND org_id = $1",
      [orgId],
    );
    expect(notified.map((row) => row.user_id).sort()).toEqual([owner.id, admin.id].sort());
    expect((await waitForEmail(admin.email)).Subject).toBe(
      "Webhook endpoint turned off: https://example.com/hook",
    );
  });

  it("keeps each user's inbox private at the database level", async () => {
    const user = await newUser();
    await settle(await reminder(user.id), 2);
    const client = new pg.Client({ connectionString: testDb.urlFor("app_notifications") });
    await client.connect();
    const unscoped = await client.query("SELECT id FROM notifications.notification");
    await client.end();
    expect(unscoped.rowCount).toBe(0);
  });
});
