/**
 * The webhooks service against a real (cloned) database, a private Redis database and a
 * local HTTP receiver: signed deliveries, retries, auto-disable, SSRF refusal, replay,
 * and Stripe's inbound events.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { EventName } from "@repo/contracts/events";
import { createTestDatabase, type TestDatabase } from "@repo/db/testing";
import { createProducer } from "@repo/jobs";
import { createRedis, keysFromEnv, SecretBox } from "@repo/nest-common";
import { redisDatabase } from "@repo/nest-common/testing";
import pg from "pg";
import { Webhook } from "standardwebhooks";
import Stripe from "stripe";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DeliveryService as Deliveries } from "../src/outbound/delivery.service";

const ENCRYPTION_KEYS = `test:${randomBytes(32).toString("base64")}`;
const STRIPE_SECRET = `whsec_${randomBytes(24).toString("base64")}`;
const RESEND_SECRET = `whsec_${randomBytes(24).toString("base64")}`;
const box = new SecretBox(keysFromEnv(ENCRYPTION_KEYS));

let testDb: TestDatabase;
let app: NestFastifyApplication;
let baseUrl: string;
let deliveries: Deliveries;

// ---------------------------------------------------------------------------- receiver

interface Received {
  headers: IncomingHttpHeaders;
  body: string;
}
let receiver: Server;
let receiverUrl: string;
let received: Received[] = [];
/** Status codes the receiver answers with, in order (then 200). */
let answers: number[] = [];

beforeEach(() => {
  received = [];
  answers = [];
});

// ---------------------------------------------------------------------------- helpers

async function asRole<T>(role: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: testDb.urlFor(role) });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** An organization with one endpoint, created the way apps/api does. */
async function endpoint(
  options: {
    url?: string;
    events?: string[];
    /** A secret replaced by a rotation, still signing until `expiresAt`. */
    previous?: { secret: string; expiresAt: Date };
  } = {},
) {
  const orgId = randomUUID();
  const secret = `whsec_${randomBytes(24).toString("base64")}`;
  const id = await asRole("app_api", async (client) => {
    await client.query(
      `INSERT INTO auth.organization (id, name, slug) VALUES ($1::uuid, 'Org', $1::text)`,
      [orgId],
    );
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO webhooks.endpoint
         (org_id, url, events, secret, previous_secret, previous_secret_expires_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now()) RETURNING id`,
      [
        orgId,
        options.url ?? receiverUrl,
        options.events ?? [],
        box.encrypt(secret),
        options.previous ? box.encrypt(options.previous.secret) : null,
        options.previous?.expiresAt ?? null,
      ],
    );
    await client.query("COMMIT");
    return rows[0]?.id as string;
  });
  return { orgId, endpointId: id, secret };
}

async function delivery(deliveryId: string) {
  return asRole("postgres", async (client) => {
    const { rows } = await client.query(
      "SELECT status, attempts, last_status, last_error FROM webhooks.delivery WHERE id = $1",
      [deliveryId],
    );
    return rows[0] as {
      status: string;
      attempts: number;
      last_status: number | null;
      last_error: string | null;
    };
  });
}

/** Publishes a domain event to the webhooks consumer queue, as the relay would. */
async function publish(orgId: string, name: EventName = "todo.created.v1") {
  const producer = createProducer("events-webhooks", createRedis(process.env.REDIS_URL as string));
  const event = {
    id: randomUUID(),
    name,
    key: randomUUID(),
    payload: { todoId: randomUUID(), title: "Ship it" },
    orgId,
    actorId: null,
    requestId: null,
    occurredAt: new Date().toISOString(),
    source: "app",
  };
  await producer.add("event", event, { jobId: event.id });
  await producer.close();
  return event;
}

async function eventually<T>(
  fn: () => Promise<T> | T,
  done: (value: T) => boolean,
  timeoutMs = 15_000,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (done(value) || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// ---------------------------------------------------------------------------- setup

beforeAll(async () => {
  receiver = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      received.push({ headers: request.headers, body });
      response.statusCode = answers.shift() ?? 200;
      response.end("ok");
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;

  testDb = await createTestDatabase();
  Object.assign(process.env, {
    WEBHOOKS_DATABASE_URL: testDb.urlFor("app_webhooks"),
    LOAD_SHEDDING: "off",
    REDIS_URL: redisDatabase(11),
    ENCRYPTION_KEYS,
    STRIPE_WEBHOOK_SECRET: STRIPE_SECRET,
    RESEND_WEBHOOK_SECRET: RESEND_SECRET,
    WEBHOOK_ALLOWED_PRIVATE_ADDRESSES: "127.0.0.1",
    WEBHOOK_AUTO_DISABLE_HOURS: "1",
  });
  const redis = createRedis(process.env.REDIS_URL as string);
  await redis.flushdb();
  await redis.quit();
  const { createWebhooksServer } = await import("../src/server");
  const { DeliveryService } = await import("../src/outbound/delivery.service");
  app = await createWebhooksServer();
  await app.listen({ port: 0, host: "127.0.0.1" });
  baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  deliveries = app.get(DeliveryService);
});

afterAll(async () => {
  await app?.close();
  await new Promise((resolve) => receiver?.close(resolve));
  await testDb?.drop();
});

// ---------------------------------------------------------------------------- tests

describe("outbound deliveries", () => {
  it("delivers a subscribed event, signed so the reference library verifies it", async () => {
    const { orgId, secret } = await endpoint();
    const event = await publish(orgId);
    await eventually(
      () => received.length,
      (n) => n === 1,
    );

    const [request] = received;
    const verified = new Webhook(secret).verify(
      request?.body ?? "",
      request?.headers as Record<string, string>,
    );
    expect(verified).toMatchObject({ type: "todo.created.v1", data: { title: "Ship it" } });
    expect(request?.headers["webhook-id"]).toBe(event.id);
    expect(request?.headers["user-agent"]).toMatch(/Boilerplate-Webhooks/);
  });

  it("signs with the rotated-out secret too until its overlap ends", async () => {
    const previous = `whsec_${randomBytes(24).toString("base64")}`;
    const hour = 60 * 60 * 1000;
    const during = await endpoint({
      previous: { secret: previous, expiresAt: new Date(Date.now() + hour) },
    });
    const after = await endpoint({
      previous: { secret: previous, expiresAt: new Date(Date.now() - hour) },
    });

    await publish(during.orgId);
    await eventually(
      () => received.length,
      (n) => n === 1,
    );
    const [overlap] = received;
    const headers = overlap?.headers as Record<string, string>;
    // Receivers holding either secret accept it.
    expect(new Webhook(during.secret).verify(overlap?.body ?? "", headers)).toBeTruthy();
    expect(new Webhook(previous).verify(overlap?.body ?? "", headers)).toBeTruthy();

    await publish(after.orgId);
    await eventually(
      () => received.length,
      (n) => n === 2,
    );
    const expired = received[1];
    const expiredHeaders = expired?.headers as Record<string, string>;
    expect(expiredHeaders["webhook-signature"]?.split(" ")).toHaveLength(1);
    expect(new Webhook(after.secret).verify(expired?.body ?? "", expiredHeaders)).toBeTruthy();
    expect(() => new Webhook(previous).verify(expired?.body ?? "", expiredHeaders)).toThrow();
  });

  it("only sends subscribed events, and nothing for other organizations", async () => {
    const { orgId } = await endpoint({ events: ["todo.deleted.v1"] });
    await publish(orgId, "todo.created.v1");
    await publish(randomUUID(), "todo.deleted.v1");
    const deleted = await publish(orgId, "todo.deleted.v1");
    await eventually(
      () => received.length,
      (n) => n >= 1,
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(received.map((r) => JSON.parse(r.body).type)).toEqual(["todo.deleted.v1"]);
    expect(received[0]?.headers["webhook-id"]).toBe(deleted.id);
  });

  it("the same event twice makes one delivery", async () => {
    const { orgId, endpointId } = await endpoint();
    const event = await publish(orgId);
    await eventually(
      () => received.length,
      (n) => n === 1,
    );
    const producer = createProducer(
      "events-webhooks",
      createRedis(process.env.REDIS_URL as string),
    );
    await producer.add("event", { ...event }, { jobId: `${event.id}-again` });
    await producer.close();
    await new Promise((resolve) => setTimeout(resolve, 800));
    const rows = await asRole("postgres", (client) =>
      client.query("SELECT count(*)::int AS n FROM webhooks.delivery WHERE endpoint_id = $1", [
        endpointId,
      ]),
    );
    expect(rows.rows[0].n).toBe(1);
    expect(received).toHaveLength(1);
  });

  it("records failures for retry, then marks the delivery failed on the last attempt", async () => {
    const { orgId, endpointId } = await endpoint();
    const deliveryId = await deliveries.createTest(orgId, endpointId);
    answers = [500, 503];
    expect(await deliveries.attempt(orgId, deliveryId, false)).toBe("retry");
    expect(await delivery(deliveryId)).toMatchObject({
      status: "pending",
      attempts: 1,
      last_status: 500,
    });
    expect(await deliveries.attempt(orgId, deliveryId, true)).toBe("failed");
    expect(await delivery(deliveryId)).toMatchObject({
      status: "failed",
      attempts: 2,
      last_status: 503,
    });
  });

  it("disables an endpoint that has failed for longer than the limit, and says so", async () => {
    const { orgId, endpointId } = await endpoint();
    // A failure from two hours ago, and nothing has succeeded since.
    const old = await deliveries.createTest(orgId, endpointId);
    answers = [500];
    await deliveries.attempt(orgId, old, true);
    await asRole("postgres", (client) =>
      client.query(
        "UPDATE webhooks.delivery SET created_at = now() - interval '2 hours' WHERE id = $1",
        [old],
      ),
    );
    const latest = await deliveries.createTest(orgId, endpointId);
    answers = [500];
    await deliveries.attempt(orgId, latest, true);

    const state = await asRole("postgres", async (client) => {
      const { rows } = await client.query(
        "SELECT disabled_reason FROM webhooks.endpoint WHERE id = $1",
        [endpointId],
      );
      const events = await client.query(
        "SELECT name FROM webhooks.outbox_event WHERE key = $1 AND name = 'webhook.endpoint_disabled.v1'",
        [endpointId],
      );
      return { reason: rows[0]?.disabled_reason, events: events.rowCount };
    });
    expect(state).toEqual({ reason: "failing", events: 1 });
  });

  it("never calls a private address that isn't explicitly allowed", async () => {
    const { orgId, endpointId } = await endpoint({ url: "http://10.0.0.1/hook" });
    const deliveryId = await deliveries.createTest(orgId, endpointId);
    expect(await deliveries.attempt(orgId, deliveryId, true)).toBe("failed");
    expect((await delivery(deliveryId)).last_error).toBe("DESTINATION_NOT_ALLOWED");
  });

  it("replays a finished delivery with the same message id", async () => {
    const { orgId, endpointId } = await endpoint();
    const deliveryId = await deliveries.createTest(orgId, endpointId);
    expect(await deliveries.attempt(orgId, deliveryId, true)).toBe("succeeded");
    const producer = createProducer(
      "webhook-deliveries",
      createRedis(process.env.REDIS_URL as string),
    );
    await producer.add("redeliver", { deliveryId, orgId }, { jobId: randomUUID() });
    await producer.close();
    await eventually(
      () => received.length,
      (n) => n === 2,
    );
    expect(received[1]?.headers["webhook-id"]).toBe(received[0]?.headers["webhook-id"]);
    expect((await delivery(deliveryId)).status).toBe("succeeded");
  });

  it("the service can't see endpoints without the organization set", async () => {
    await endpoint();
    const rows = await asRole("app_webhooks", (client) =>
      client.query("SELECT id FROM webhooks.endpoint"),
    );
    expect(rows.rowCount).toBe(0);
    await expect(
      asRole("app_webhooks", (client) => client.query("UPDATE webhooks.endpoint SET url = 'x'")),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("inbound Stripe events", () => {
  const stripeEvent = () => ({
    id: `evt_${randomUUID().replaceAll("-", "")}`,
    object: "event",
    type: "customer.subscription.updated",
    data: { object: { id: "sub_123", object: "subscription", status: "active" } },
  });
  const post = (body: string, signature: string) =>
    fetch(`${baseUrl}/webhooks/stripe`, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": signature },
      body,
    });

  it("accepts a correctly signed event once, however often Stripe sends it", async () => {
    const event = stripeEvent();
    const body = JSON.stringify(event);
    const signature = Stripe.webhooks.generateTestHeaderString({
      payload: body,
      secret: STRIPE_SECRET,
    });
    expect((await post(body, signature)).status).toBe(200);
    expect((await post(body, signature)).status).toBe(200);

    const rows = await asRole("postgres", async (client) => {
      const inbound = await client.query(
        "SELECT type FROM webhooks.inbound_event WHERE provider_event_id = $1",
        [event.id],
      );
      const outbox = await client.query(
        "SELECT payload FROM webhooks.outbox_event WHERE key = $1 AND name = 'stripe.event_received.v1'",
        [event.id],
      );
      return { inbound: inbound.rows, outbox: outbox.rows };
    });
    expect(rows.inbound).toEqual([{ type: "customer.subscription.updated" }]);
    expect(rows.outbox).toHaveLength(1);
    expect(rows.outbox[0].payload).toMatchObject({
      stripeEventId: event.id,
      object: { id: "sub_123" },
    });
  });

  it("rejects a bad signature or a changed body", async () => {
    const body = JSON.stringify(stripeEvent());
    const wrongSecret = Stripe.webhooks.generateTestHeaderString({
      payload: body,
      secret: `whsec_${randomBytes(24).toString("base64")}`,
    });
    expect((await post(body, wrongSecret)).status).toBe(400);
    const signature = Stripe.webhooks.generateTestHeaderString({
      payload: body,
      secret: STRIPE_SECRET,
    });
    expect((await post(body.replace("active", "canceled"), signature)).status).toBe(400);
    expect((await post(body, "")).status).toBe(400);
  });
});

describe("inbound Resend feedback", () => {
  /** Posts a Resend event signed the way Svix signs (Standard Webhooks, svix-* headers). */
  async function post(
    event: unknown,
    options: { id?: string; secret?: string; at?: Date; body?: string } = {},
  ) {
    const id = options.id ?? `msg_${randomUUID()}`;
    const at = options.at ?? new Date();
    const payload = JSON.stringify(event);
    const signature = new Webhook(options.secret ?? RESEND_SECRET).sign(id, at, payload);
    const response = await fetch(`${baseUrl}/webhooks/resend`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "svix-id": id,
        "svix-timestamp": String(Math.floor(at.getTime() / 1000)),
        "svix-signature": signature,
      },
      body: options.body ?? payload,
    });
    return { id, status: response.status };
  }
  const feedback = (key: string) =>
    asRole("postgres", async (client) => {
      const { rows } = await client.query(
        "SELECT payload FROM webhooks.outbox_event WHERE name = 'email.feedback_received.v1' AND key LIKE $1",
        [`${key}:%`],
      );
      return rows.map((row) => row.payload);
    });
  const bounced = (to: string[], type = "Permanent") => ({
    type: "email.bounced",
    data: { email_id: randomUUID(), to, bounce: { type, message: "550 no such user" } },
  });

  it("turns a hard bounce into feedback for each address, once however often it's sent", async () => {
    const event = bounced(["gone@example.com", "also-gone@example.com"]);
    const first = await post(event);
    expect(first.status).toBe(200);
    expect((await post(event, { id: first.id })).status).toBe(200);
    expect(await feedback(first.id)).toEqual([
      { provider: "resend", kind: "bounce", address: "gone@example.com" },
      { provider: "resend", kind: "bounce", address: "also-gone@example.com" },
    ]);
  });

  it("turns a spam complaint into feedback", async () => {
    const { id } = await post({ type: "email.complained", data: { to: ["annoyed@example.com"] } });
    expect(await feedback(id)).toEqual([
      { provider: "resend", kind: "complaint", address: "annoyed@example.com" },
    ]);
  });

  it("records but doesn't act on transient bounces and other events", async () => {
    const transient = await post(bounced(["busy@example.com"], "Transient"));
    const delivered = await post({ type: "email.delivered", data: { to: ["ok@example.com"] } });
    expect([transient.status, delivered.status]).toEqual([200, 200]);
    expect(await feedback(transient.id)).toEqual([]);
    expect(await feedback(delivered.id)).toEqual([]);
    const stored = await asRole("postgres", (client) =>
      client.query(
        "SELECT type FROM webhooks.inbound_event WHERE provider = 'resend' AND provider_event_id = $1",
        [delivered.id],
      ),
    );
    expect(stored.rows).toEqual([{ type: "email.delivered" }]);
  });

  it("refuses another secret, a changed body, an old timestamp and missing headers", async () => {
    const event = bounced(["x@example.com"]);
    expect(
      (await post(event, { secret: `whsec_${randomBytes(24).toString("base64")}` })).status,
    ).toBe(400);
    expect((await post(event, { body: JSON.stringify(bounced(["y@example.com"])) })).status).toBe(
      400,
    );
    expect((await post(event, { at: new Date(Date.now() - 10 * 60 * 1000) })).status).toBe(400);
    const bare = await fetch(`${baseUrl}/webhooks/resend`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(bare.status).toBe(400);
  });
});
