/**
 * Billing against a stateful fake Stripe (packages/fake-stripe). Its webhooks are received
 * here the way apps/webhooks and the relay would pass them on: verified, then queued as
 * `stripe.event_received.v1` for the billing consumer running in this API. Membership
 * events are relayed from the outbox the same way. (A separate file: billing must be on.)
 */
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ORPCError } from "@orpc/client";
import { type FakeStripe, startFakeStripe } from "@repo/fake-stripe";
import { createProducer, queuePrefix } from "@repo/jobs";
import { Queue } from "bullmq";
import pg from "pg";
import Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSession,
  type Harness,
  newEmail,
  newPassword,
  startApi,
  takeNotification,
  takeOtp,
} from "./harness";

const SECRET_KEY = `sk_test_${randomUUID().replaceAll("-", "")}`;
const WEBHOOK_SECRET = `whsec_${randomUUID().replaceAll("-", "")}`;
const MONTHLY = "price_pro_monthly_test";
const YEARLY = "price_pro_yearly_test";

let harness: Harness;
let stripe: FakeStripe;
let receiver: Server;
let events: ReturnType<typeof createProducer<"events-billing">>;

beforeAll(async () => {
  // Stands in for apps/webhooks + the outbox relay: verify, then queue for billing.
  receiver = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const event = await Stripe.webhooks.constructEventAsync(
      Buffer.concat(chunks),
      String(request.headers["stripe-signature"]),
      WEBHOOK_SECRET,
    );
    await queueEvent("stripe.event_received.v1", event.id, {
      inboundEventId: randomUUID(),
      stripeEventId: event.id,
      type: event.type,
      object: event.data.object as unknown as Record<string, unknown>,
    });
    response.writeHead(200).end();
  });
  await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  stripe = await startFakeStripe({
    secretKey: SECRET_KEY,
    webhookSecret: WEBHOOK_SECRET,
    webhookUrl: `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/`,
    prices: {
      [MONTHLY]: { interval: "month", unitAmount: 1_200 },
      [YEARLY]: { interval: "year", unitAmount: 12_000 },
    },
  });
  harness = await startApi(10, {
    STRIPE_SECRET_KEY: SECRET_KEY,
    STRIPE_PRICE_PRO_MONTHLY: MONTHLY,
    STRIPE_PRICE_PRO_YEARLY: YEARLY,
    STRIPE_API_URL: stripe.url,
    STRIPE_TRIAL_DAYS: "14",
  });
  events = createProducer("events-billing", harness.redis);
});

afterAll(async () => {
  await events?.close();
  await harness?.close();
  await stripe?.close();
  await new Promise((resolve) => receiver?.close(resolve));
});

async function queueEvent(
  name: string,
  key: string,
  payload: unknown,
  orgId: string | null = null,
) {
  const id = randomUUID();
  await events.add(
    "event",
    {
      id,
      name,
      key,
      payload,
      orgId,
      actorId: null,
      requestId: null,
      occurredAt: new Date().toISOString(),
      source: "webhooks",
    },
    { jobId: id },
  );
}

async function sql<T = Record<string, unknown>>(query: string, params: unknown[] = []) {
  const client = new pg.Client({ connectionString: harness.testDb.urlFor("postgres") });
  await client.connect();
  try {
    return (await client.query(query, params)).rows as T[];
  } finally {
    await client.end();
  }
}

/** What the relay does for membership changes: pass the outbox's events to billing. */
async function relayMembership(orgId: string) {
  const rows = await sql<{ id: string; name: string; key: string; payload: unknown }>(
    `SELECT id, name, key, payload FROM app.outbox_event
     WHERE org_id = $1 AND name IN ('org.member_added.v1', 'org.member_removed.v1')`,
    [orgId],
  );
  for (const row of rows) await queueEvent(row.name, row.key, row.payload, orgId);
}

async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function signedIn() {
  const session = createSession(harness);
  const email = newEmail();
  await session.auth("/sign-up/email", { email, password: newPassword(), name: "Billing" });
  const { otp } = await takeOtp(harness, email);
  await session.auth("/email-otp/verify-email", { email, otp });
  return { session, email };
}

/** A shared workspace, active for its owner. */
async function workspace() {
  const owner = await signedIn();
  const org = await owner.session.auth<{ id: string }>("/organization/create", {
    name: "Acme",
    slug: `acme-${randomUUID().slice(0, 8)}`,
  });
  await owner.session.auth("/organization/set-active", { organizationId: org.body.id });
  return { owner, orgId: org.body.id };
}

async function invite(session: ReturnType<typeof createSession>, orgId: string, email: string) {
  return session.auth<{ code?: string }>("/organization/invite-member", {
    email,
    role: "member",
    organizationId: orgId,
  });
}

async function join(owner: ReturnType<typeof createSession>, orgId: string, role = "member") {
  const member = await signedIn();
  await owner.auth("/organization/invite-member", {
    email: member.email,
    role,
    organizationId: orgId,
  });
  const invitation = await takeNotification(harness, "org.invitation", member.email);
  const invitationId = new URL(invitation.data.acceptUrl).pathname.split("/").at(-1);
  await member.session.auth("/organization/accept-invitation", { invitationId });
  await member.session.auth("/organization/set-active", { organizationId: orgId });
  return member;
}

/** Subscribes through the fake Stripe's hosted checkout, as a browser would. */
async function subscribe(
  session: ReturnType<typeof createSession>,
  interval: "month" | "year" = "month",
) {
  const { url } = await session.rpc.billing.checkout({ interval });
  expect(url).toMatch(new RegExp(`^${stripe.url}/checkout/cs_`));
  const paid = await fetch(`${url}/pay`, { method: "POST", redirect: "manual" });
  expect(paid.status).toBe(303);
  expect(paid.headers.get("location")).toContain("/settings/billing?checkout=done");
  return eventually(
    () => session.rpc.billing.overview(),
    (overview) => overview.plan === "pro",
  );
}

async function expectError(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error, `expected ${code}`).toBeInstanceOf(ORPCError);
  expect((error as ORPCError<string, unknown>).code).toBe(code);
  return error as ORPCError<string, { params?: unknown }>;
}

describe("plans and entitlements", () => {
  it("starts on Free: three members and no webhooks", async () => {
    const { owner } = await workspace();
    expect(await owner.session.rpc.billing.overview()).toEqual({
      enabled: true,
      plan: "free",
      entitlements: { members: 3, webhooks: false },
      members: 1,
      subscription: null,
    });
    expect((await owner.session.rpc.system.info()).features.billing).toBe(true);
    const error = await expectError(
      owner.session.rpc.webhooks.createEndpoint({ url: "https://example.com/hook" }),
      "ENTITLEMENT_REQUIRED",
    );
    expect(error.data?.params).toEqual({ entitlement: "webhooks" });
  });

  it("counts pending invitations towards the member limit", async () => {
    const { owner, orgId } = await workspace();
    expect((await invite(owner.session, orgId, newEmail())).status).toBe(200);
    expect((await invite(owner.session, orgId, newEmail())).status).toBe(200);
    const refused = await invite(owner.session, orgId, newEmail());
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("ENTITLEMENT_REQUIRED");
  });

  it("only owners and admins see or change billing", async () => {
    const { owner, orgId } = await workspace();
    const member = await join(owner.session, orgId);
    await expectError(member.session.rpc.billing.overview(), "FORBIDDEN");
    await expectError(member.session.rpc.billing.checkout({ interval: "month" }), "FORBIDDEN");
    await expectError(member.session.rpc.billing.portal(), "FORBIDDEN");
  });
});

describe("subscribing", () => {
  it("checkout starts a trial on Pro, per seat, and unlocks the plan", async () => {
    const { owner, orgId } = await workspace();
    await join(owner.session, orgId);
    const overview = await subscribe(owner.session);
    expect(overview).toMatchObject({
      plan: "pro",
      entitlements: { members: null, webhooks: true },
      members: 2,
      subscription: {
        status: "trialing",
        interval: "month",
        seats: 2,
        cancelAtPeriodEnd: false,
        trialEnd: expect.any(Date),
      },
    });
    const days = ((overview.subscription?.trialEnd?.getTime() ?? 0) - Date.now()) / 86_400_000;
    expect(Math.round(days)).toBe(14);
    await expect(
      owner.session.rpc.webhooks.createEndpoint({ url: "https://example.com/hook" }),
    ).resolves.toMatchObject({ endpoint: { url: "https://example.com/hook" } });
    for (let i = 0; i < 3; i++) {
      expect((await invite(owner.session, orgId, newEmail())).status).toBe(200);
    }
    // The subscription is tied to the workspace in Stripe.
    expect(stripe.subscriptionFor(orgId)?.metadata).toEqual({ orgId });
  });

  it("refuses a second subscription, and makes one Stripe customer per workspace", async () => {
    const { owner, orgId } = await workspace();
    const [first, second] = await Promise.all([
      owner.session.rpc.billing.checkout({ interval: "month" }),
      owner.session.rpc.billing.checkout({ interval: "year" }),
    ]);
    expect(first.url).not.toBe(second.url);
    const customers = [...stripe.customers.values()].filter((c) => c.metadata.orgId === orgId);
    expect(customers).toHaveLength(1);
    expect(
      await sql("SELECT stripe_customer_id FROM billing.customer WHERE org_id = $1", [orgId]),
    ).toEqual([{ stripe_customer_id: customers[0]?.id }]);

    await fetch(`${first.url}/pay`, { method: "POST", redirect: "manual" });
    await eventually(
      () => owner.session.rpc.billing.overview(),
      (overview) => overview.plan === "pro",
    );
    await expectError(
      owner.session.rpc.billing.checkout({ interval: "year" }),
      "ALREADY_SUBSCRIBED",
    );
  });

  it("a declined card leaves the workspace on Free", async () => {
    const { owner } = await workspace();
    const { url } = await owner.session.rpc.billing.checkout({ interval: "month" });
    const declined = await fetch(`${url}/pay`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "card=declined",
    });
    expect(declined.status).toBe(402);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect((await owner.session.rpc.billing.overview()).plan).toBe("free");
  });

  it("gives one free trial per workspace", async () => {
    const { owner, orgId } = await workspace();
    await subscribe(owner.session);
    const subscription = stripe.subscriptionFor(orgId);
    await fetch(`${stripe.url}/__fake/subscriptions/${subscription?.id}/lapse`, { method: "POST" });
    await eventually(
      () => owner.session.rpc.billing.overview(),
      (overview) => overview.plan === "free",
    );
    const again = await subscribe(owner.session, "year");
    expect(again.subscription).toMatchObject({
      status: "active",
      interval: "year",
      trialEnd: null,
    });
  });
});

describe("keeping in sync with Stripe", () => {
  it("bills per seat as members join and leave", async () => {
    const { owner, orgId } = await workspace();
    await subscribe(owner.session);
    const member = await join(owner.session, orgId);
    await relayMembership(orgId);
    await eventually(
      async () => stripe.subscriptionFor(orgId)?.items.data[0]?.quantity,
      (quantity) => quantity === 2,
    );
    await eventually(
      () => owner.session.rpc.billing.overview(),
      (overview) => overview.subscription?.seats === 2,
    );
    await owner.session.auth("/organization/remove-member", {
      memberIdOrEmail: member.email,
      organizationId: orgId,
    });
    await relayMembership(orgId);
    expect(
      await eventually(
        async () => stripe.subscriptionFor(orgId)?.items.data[0]?.quantity,
        (quantity) => quantity === 1,
      ),
    ).toBe(1);
  });

  it("a failed renewal keeps Pro while Stripe retries, and tells owners and admins", async () => {
    const { owner, orgId } = await workspace();
    await subscribe(owner.session);
    const subscription = stripe.subscriptionFor(orgId);
    await fetch(`${stripe.url}/__fake/subscriptions/${subscription?.id}/payment-failed`, {
      method: "POST",
    });
    const overview = await eventually(
      () => owner.session.rpc.billing.overview(),
      (current) => current.subscription?.status === "past_due",
    );
    expect(overview.plan).toBe("pro");

    const queue = new Queue("notifications-critical", {
      connection: harness.redis,
      prefix: queuePrefix("notifications-critical"),
    });
    const jobs = await eventually(
      async () =>
        (await queue.getJobs(["waiting", "delayed", "prioritized"])).filter(
          (job) =>
            job.data.payload.template === "billing.payment-failed" &&
            job.data.payload.to.orgId === orgId,
        ),
      (found) => found.length > 0,
    );
    await queue.close();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.data.payload).toMatchObject({
      to: { orgId, roles: ["owner", "admin"] },
      data: { organizationName: "Acme", amount: 1_200, currency: "USD" },
    });
  });

  it("the portal cancels at the end of the period; the plan lasts until then", async () => {
    const { owner } = await workspace();
    await subscribe(owner.session);
    const { url } = await owner.session.rpc.billing.portal();
    expect(url).toMatch(new RegExp(`^${stripe.url}/portal/bps_`));
    await fetch(`${url}/cancel`, { method: "POST", redirect: "manual" });
    const overview = await eventually(
      () => owner.session.rpc.billing.overview(),
      (current) => current.subscription?.cancelAtPeriodEnd === true,
    );
    expect(overview.plan).toBe("pro");
    await fetch(`${url}/resume`, { method: "POST", redirect: "manual" });
    await eventually(
      () => owner.session.rpc.billing.overview(),
      (current) => current.subscription?.cancelAtPeriodEnd === false,
    );
  });

  it("an old event replayed late can't undo a newer change", async () => {
    const { owner, orgId } = await workspace();
    await subscribe(owner.session);
    const subscription = stripe.subscriptionFor(orgId);
    const stale = structuredClone(subscription);
    await fetch(`${(await owner.session.rpc.billing.portal()).url}/cancel`, {
      method: "POST",
      redirect: "manual",
    });
    await eventually(
      () => owner.session.rpc.billing.overview(),
      (current) => current.subscription?.cancelAtPeriodEnd === true,
    );
    // The creation event arrives again, with the old state in it.
    await queueEvent("stripe.event_received.v1", "evt_replayed", {
      inboundEventId: randomUUID(),
      stripeEventId: "evt_replayed",
      type: "customer.subscription.created",
      object: stale as unknown as Record<string, unknown>,
    });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect((await owner.session.rpc.billing.overview()).subscription?.cancelAtPeriodEnd).toBe(true);
  });

  it("lists invoices, and ignores subscriptions that aren't the app's", async () => {
    const { owner } = await workspace();
    expect(await owner.session.rpc.billing.invoices()).toEqual([]);
    await expectError(owner.session.rpc.billing.portal(), "NO_SUBSCRIPTION");
    await subscribe(owner.session);
    const invoices = await owner.session.rpc.billing.invoices();
    expect(invoices).toEqual([
      expect.objectContaining({
        status: "paid",
        amount: 0,
        currency: "usd",
        url: expect.any(String),
      }),
    ]);

    const before = await sql("SELECT count(*)::int AS n FROM billing.subscription");
    await queueEvent("stripe.event_received.v1", "evt_foreign", {
      inboundEventId: randomUUID(),
      stripeEventId: "evt_foreign",
      type: "customer.subscription.updated",
      object: { id: "sub_not_ours" },
    });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(await sql("SELECT count(*)::int AS n FROM billing.subscription")).toEqual(before);
  });

  it("deleting a workspace cancels its subscription first", async () => {
    const { owner, orgId } = await workspace();
    await subscribe(owner.session);
    const response = await owner.session.auth("/organization/delete", { organizationId: orgId });
    expect(response.status).toBe(200);
    expect(stripe.subscriptionFor(orgId)?.status).toBe("canceled");
  });

  it("keeps each workspace's billing private", async () => {
    const { owner, orgId } = await workspace();
    await subscribe(owner.session);
    const client = new pg.Client({ connectionString: harness.testDb.urlFor("app_api") });
    await client.connect();
    const unscoped = await client.query("SELECT id FROM billing.subscription");
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.org_id', $1, true)", [randomUUID()]);
    const other = await client.query("SELECT id FROM billing.subscription");
    await client.query("COMMIT");
    await client.end();
    expect(unscoped.rowCount).toBe(0);
    expect(other.rowCount).toBe(0);
    expect(await sql("SELECT 1 FROM billing.subscription WHERE org_id = $1", [orgId])).toHaveLength(
      1,
    );
  });
});
