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
    template: z.literal("todo.reminder"),
    to: z.object({ userId: z.string() }),
    data: z.object({ todoId: z.string(), title: z.string() }),
  }),
]);
export type NotificationPayload = z.infer<typeof notificationPayload>;
export type NotificationTemplate = NotificationPayload["template"];

const DAY = 24 * 60 * 60;

/** Retries with exponential backoff; the defaults every queue starts from. */
const retrying: JobsOptions = { attempts: 5, backoff: { type: "exponential", delay: 2_000 } };

export const queues = {
  /**
   * Time-critical notifications (sign-in codes, security alerts, billing failures). Its
   * own queue and worker pool so a large digest can never delay a sign-in code.
   * Payloads can hold one-time codes, so they are deleted as soon as they complete.
   */
  "notifications-critical": {
    jobs: { send: notificationPayload },
    options: { ...retrying, removeOnComplete: true, removeOnFail: { age: 60 * 60 } },
  },
  /** Everything else users are notified about: reminders, digests, product updates. */
  "notifications-bulk": {
    jobs: { send: notificationPayload },
    options: {
      ...retrying,
      removeOnComplete: { age: DAY, count: 10_000 },
      removeOnFail: { age: 7 * DAY },
    },
  },
} as const satisfies Record<string, { jobs: Record<string, z.ZodType>; options: JobsOptions }>;

/** Which notification queue a template goes to. A new template must pick one. */
export const notificationQueue = {
  "auth.otp": "notifications-critical",
  "org.invitation": "notifications-critical",
  "todo.reminder": "notifications-bulk",
} as const satisfies Record<NotificationTemplate, keyof typeof queues>;

export type QueueName = keyof typeof queues;
export type JobName<Q extends QueueName> = keyof (typeof queues)[Q]["jobs"] & string;
export type JobPayload<Q extends QueueName, J extends JobName<Q>> = z.infer<
  (typeof queues)[Q]["jobs"][J]
>;
