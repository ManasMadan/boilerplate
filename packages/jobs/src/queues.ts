/**
 * Every queue in the system, the jobs it carries (each with a zod payload schema), and
 * how long finished jobs are kept.
 *
 * This file is the contract between services, which never import each other's code
 * or call each other directly; they only exchange jobs and events. A producer can only
 * enqueue a job that exists here with a payload that type-checks, and a consumer
 * re-validates the payload before processing, because during a rolling deploy the
 * producer and consumer can be different versions.
 *
 * Direct jobs are for work that can be re-created if Redis is lost (an email, a
 * thumbnail). Anything that must never be lost is written to the database outbox in
 * the same transaction as the change and relayed to a queue from there.
 *
 * Python consumers (apps/ai) read the same queues; their Pydantic models are generated
 * from these schemas (see docs/jobs-and-events.md).
 */
import { type EventName, eventEnvelope, webhookEvents } from "@repo/contracts/events";
import { locales } from "@repo/i18n";
import type { JobsOptions } from "bullmq";
import { z } from "zod";

/**
 * BullMQ key prefix for a queue: the queue name in braces, i.e. a Redis Cluster hash
 * tag. Every key of one queue lands in the same slot (BullMQ's Lua scripts need that),
 * while different queues spread across slots, so moving to a cluster needs no key
 * migration. Producers and consumers (Node and Python) must use exactly this prefix.
 * KEDA scales a queue's workers on `LLEN {<queue>}:<queue>:wait`, so queues that KEDA
 * scales must not use job priorities (prioritized jobs live in a separate sorted set).
 */
export const queuePrefix = (queue: string) => `{${queue}}`;

/**
 * Who and what caused a job, copied from the producer's request context. Workers
 * restore it before processing, so their logs carry the same request id as the HTTP
 * request that enqueued the job. Every job is stored as `{ meta, payload }`.
 */
export const jobMeta = z.object({
  requestId: z.string().optional(),
  userId: z.string().optional(),
  orgId: z.string().optional(),
});
export type JobMeta = z.infer<typeof jobMeta>;

const email = z.email();
const phone = z.string().regex(/^\+[1-9]\d{6,14}$/);

/**
 * Account changes the owner is told about (by email, and by text when they have a
 * verified phone), so a takeover can't happen silently.
 */
export const SECURITY_EVENTS = [
  "email-changed",
  "password-changed",
  "password-reset",
  "two-factor-enabled",
  "two-factor-disabled",
  "passkey-added",
  "phone-added",
  "phone-removed",
] as const;
export type SecurityEvent = (typeof SECURITY_EVENTS)[number];
const locale = z.enum(locales);

/** Notification templates. The notification service owns rendering and channels. */
export const notificationPayload = z.discriminatedUnion("template", [
  z.object({
    template: z.literal("auth.otp"),
    // Codes can be sent before an account exists, so the recipient carries its own
    // locale (negotiated from the request); user-addressed templates use the user's saved one.
    to: z.object({ email, locale }),
    data: z.object({
      otp: z.string(),
      purpose: z.enum(["sign-in", "email-verification", "forget-password", "change-email"]),
      expiresInMinutes: z.number().int().positive(),
    }),
  }),
  z.object({
    template: z.literal("auth.phone-code"),
    // Texted to a number being verified, which isn't on the account yet.
    to: z.object({ phone, locale }),
    data: z.object({ code: z.string(), expiresInMinutes: z.number().int().positive() }),
  }),
  z.object({
    template: z.literal("org.invitation"),
    // Invitees may not have an account yet, so the address carries its own locale.
    to: z.object({ email, locale }),
    data: z.object({
      organizationName: z.string(),
      inviterName: z.string(),
      acceptUrl: z.url(),
      expiresInDays: z.number().int().positive(),
    }),
  }),
  z.object({
    template: z.literal("auth.security-alert"),
    // Sent to the address that was on the account at the time: after an email change,
    // that is the old one, which is exactly who needs to hear about it. Also texted to
    // the verified phone, if any (after a phone change, the old number).
    to: z.object({ email, locale, phone: phone.optional() }),
    data: z.object({
      event: z.enum(SECURITY_EVENTS),
      /** For email-changed: the address the account moved to. */
      newEmail: email.optional(),
      /** Where to review devices and change the password. */
      securityUrl: z.url(),
    }),
  }),
  z.object({
    template: z.literal("webhooks.endpoint-disabled"),
    // Everyone in the organization with one of these roles.
    to: z.object({ orgId: z.uuid(), roles: z.array(z.enum(["owner", "admin", "member"])).min(1) }),
    data: z.object({ endpointId: z.uuid(), url: z.string() }),
  }),
  z.object({
    template: z.literal("billing.payment-failed"),
    to: z.object({ orgId: z.uuid(), roles: z.array(z.enum(["owner", "admin", "member"])).min(1) }),
    data: z.object({
      organizationName: z.string(),
      /** Minor units (cents), and an ISO 4217 code. */
      amount: z.number().int().nonnegative(),
      currency: z.string().regex(/^[A-Z]{3}$/),
      billingUrl: z.url(),
    }),
  }),
  z.object({
    template: z.literal("todo.reminder"),
    to: z.object({ userId: z.string() }),
    data: z.object({ todoId: z.string(), title: z.string() }),
  }),
]);
export type NotificationPayload = z.infer<typeof notificationPayload>;

/**
 * One channel of a notification, delayed until the recipient's quiet hours end. Keeps
 * the original delivery key, so it still can't be sent twice.
 */
export const deferredDelivery = z.object({
  payload: notificationPayload,
  // Only push waits for quiet hours today: texts are security messages, which never wait.
  channel: z.enum(["push"]),
  userId: z.uuid(),
  key: z.string(),
});
export type NotificationTemplate = NotificationPayload["template"];

const DAY = 24 * 60 * 60;

/**
 * When failed webhook deliveries are retried, after the first attempt (Standard Webhooks'
 * recommended schedule): 5s, 5m, 30m, 2h, 5h, 10h, 10h.
 */
export const WEBHOOK_RETRY_DELAYS_MS = [
  5_000,
  5 * 60_000,
  30 * 60_000,
  2 * 3_600_000,
  5 * 3_600_000,
  10 * 3_600_000,
  10 * 3_600_000,
];

/** Retries with exponential backoff; the defaults every queue starts from. */
const retrying: JobsOptions = { attempts: 5, backoff: { type: "exponential", delay: 2_000 } };

export const queues = {
  /**
   * Time-critical notifications (sign-in codes, security alerts, billing failures). Its
   * own queue and worker pool so a large digest can never delay a sign-in code.
   * Payloads can hold one-time codes, so they are deleted as soon as they complete.
   */
  "notifications-critical": {
    jobs: { send: notificationPayload, deferred: deferredDelivery },
    options: { ...retrying, removeOnComplete: true, removeOnFail: { age: 60 * 60 } },
  },
  /** Everything else users are notified about: reminders, digests, product updates. */
  "notifications-bulk": {
    jobs: {
      send: notificationPayload,
      deferred: deferredDelivery,
      /** Hourly: queues a `digest` for each user whose digest time has come today. */
      digests: z.object({}),
      /** One user's daily digest email, for one local date (YYYY-MM-DD). */
      digest: z.object({ userId: z.uuid(), date: z.iso.date() }),
    },
    options: {
      ...retrying,
      removeOnComplete: { age: DAY, count: 10_000 },
      removeOnFail: { age: 7 * DAY },
    },
  },
  /**
   * Domain events, one queue per consumer (see `eventSubscribers`). The relay in
   * apps/worker fills them from the outbox with jobId = event id, so a redelivered event
   * is ignored while its job is still kept; consumers are idempotent on the event id
   * beyond that window.
   */
  "events-audit": {
    jobs: { event: eventEnvelope },
    options: { ...retrying, removeOnComplete: { age: DAY }, removeOnFail: { age: 30 * DAY } },
  },
  "events-webhooks": {
    jobs: { event: eventEnvelope },
    options: { ...retrying, removeOnComplete: { age: DAY }, removeOnFail: { age: 30 * DAY } },
  },
  /** Domain events that notify someone (apps/notifications maps them to templates). */
  "events-notifications": {
    jobs: { event: eventEnvelope },
    options: { ...retrying, removeOnComplete: { age: DAY }, removeOnFail: { age: 30 * DAY } },
  },
  /** Live UI updates (apps/worker → Redis pub/sub → the api's SSE streams); short-lived. */
  "events-realtime": {
    jobs: { event: eventEnvelope },
    options: {
      attempts: 3,
      backoff: { type: "fixed", delay: 1_000 },
      removeOnComplete: true,
      removeOnFail: { age: DAY },
    },
  },
  "events-billing": {
    jobs: { event: eventEnvelope },
    options: { ...retrying, removeOnComplete: { age: DAY }, removeOnFail: { age: 30 * DAY } },
  },
  /**
   * Outgoing customer webhooks (apps/webhooks). One job per delivery (jobId = delivery
   * id); retried on the Standard Webhooks schedule (`WEBHOOK_RETRY_DELAYS_MS`) through
   * the worker's custom backoff, so a failing endpoint is tried for about a day.
   */
  "webhook-deliveries": {
    jobs: {
      deliver: z.object({ deliveryId: z.uuid(), orgId: z.uuid() }),
      /** Send an existing delivery again (admin replay from the delivery log). */
      redeliver: z.object({ deliveryId: z.uuid(), orgId: z.uuid() }),
      /** A test event to one endpoint, from its settings page. */
      "send-test": z.object({ endpointId: z.uuid(), orgId: z.uuid() }),
    },
    options: {
      attempts: 8,
      backoff: { type: "webhook" },
      removeOnComplete: { age: DAY },
      removeOnFail: { age: 7 * DAY },
    },
  },
  /** Scheduled housekeeping in apps/worker (retention, partitions). */
  /**
   * Checking uploads (apps/worker): type sniffing, virus scan, image re-encoding. The job
   * id is the file id, so completing an upload twice checks it once.
   */
  files: {
    jobs: { process: z.object({ fileId: z.uuid() }) },
    options: { ...retrying, removeOnComplete: { age: DAY }, removeOnFail: { age: 7 * DAY } },
  },
  maintenance: {
    jobs: {
      "outbox-retention": z.object({}),
      "audit-partitions": z.object({}),
      "session-retention": z.object({}),
      "files-cleanup": z.object({}),
    },
    options: {
      attempts: 3,
      backoff: { type: "exponential", delay: 60_000 },
      removeOnComplete: { count: 100 },
      removeOnFail: { age: 30 * DAY },
    },
  },
} as const satisfies Record<string, { jobs: Record<string, z.ZodType>; options: JobsOptions }>;

/** Which notification queue a template goes to. A new template must pick one. */
export const notificationQueue = {
  "auth.otp": "notifications-critical",
  "auth.phone-code": "notifications-critical",
  "org.invitation": "notifications-critical",
  "auth.security-alert": "notifications-critical",
  "webhooks.endpoint-disabled": "notifications-critical",
  "billing.payment-failed": "notifications-critical",
  "todo.reminder": "notifications-bulk",
} as const satisfies Record<NotificationTemplate, keyof typeof queues>;
export type NotificationQueue = (typeof notificationQueue)[NotificationTemplate];

export type QueueName = keyof typeof queues;
export type JobName<Q extends QueueName> = keyof (typeof queues)[Q]["jobs"] & string;
export type JobPayload<Q extends QueueName, J extends JobName<Q>> = z.infer<
  (typeof queues)[Q]["jobs"][J]
>;

/**
 * Who receives which domain events. The relay copies each event into every queue whose
 * filter accepts it. A new consumer gets a queue above and a line here; it sees events
 * from the moment it's added (older ones can be replayed from the outbox's retention).
 */
const customerFacing: ReadonlySet<string> = new Set<EventName>(webhookEvents);
export const eventSubscribers = {
  "events-audit": () => true,
  "events-webhooks": (name: string) => customerFacing.has(name),
  // Stripe's events, and membership changes (paid plans are billed per seat).
  "events-billing": (name: string) =>
    name === "stripe.event_received.v1" ||
    name === "org.member_added.v1" ||
    name === "org.member_removed.v1",
  "events-notifications": (name: string) => name === "webhook.endpoint_disabled.v1",
  "events-realtime": (name: string) => name.startsWith("todo."),
} as const satisfies Partial<Record<QueueName, (name: string) => boolean>>;
export type EventQueue = keyof typeof eventSubscribers;
