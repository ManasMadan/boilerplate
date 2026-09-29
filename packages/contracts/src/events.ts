/**
 * Domain events: facts that happened, published through the transactional outbox and
 * consumed by the audit log, customer webhooks and notifications.
 *
 * Names are versioned (`todo.completed.v1`). Adding an optional field is compatible;
 * anything else is a new version, published alongside the old one until every
 * consumer has moved. Consumers must be idempotent (events are delivered at least once)
 * and must not depend on order.
 *
 * Adding an event: define its payload here, emit it with `emitEvent(tx, ...)` in the
 * same transaction as the change, and add it to `webhookEvents` if customers may
 * subscribe to it. The audit log records every event automatically.
 */
import { z } from "zod";

const todoEvent = z.object({ todoId: z.uuid(), title: z.string() });
const userEvent = z.object({ userId: z.uuid() });
const memberEvent = z.object({ organizationId: z.uuid(), userId: z.uuid(), role: z.string() });

export const events = {
  "todo.created.v1": todoEvent,
  "todo.completed.v1": todoEvent,
  "todo.deleted.v1": z.object({ todoId: z.uuid() }),

  // Account security. Written after better-auth has committed its own change (it owns
  // those writes), so, unlike product events, these are recorded just after the fact.
  "auth.signed_up.v1": userEvent,
  "auth.session_started.v1": userEvent.extend({
    sessionId: z.string(),
    method: z.enum([
      "password",
      "passkey",
      "social",
      "two-factor",
      "email-code",
      "impersonation",
      "other",
    ]),
  }),
  "auth.session_ended.v1": userEvent.extend({
    sessionId: z.string(),
    reason: z.enum([
      "sign-out",
      "revoked",
      "password-change",
      "password-reset",
      "account-deleted",
      "other",
    ]),
  }),
  "auth.password_changed.v1": userEvent,
  "auth.password_reset.v1": userEvent,
  "auth.email_changed.v1": userEvent,
  "auth.two_factor_changed.v1": userEvent.extend({ enabled: z.boolean() }),
  "auth.passkey_added.v1": userEvent,
  "auth.phone_changed.v1": userEvent.extend({ change: z.enum(["added", "removed"]) }),
  /** An OAuth (MCP) client was approved for, or disconnected from, one of the user's workspaces. */
  "auth.app_connected.v1": userEvent.extend({ clientId: z.string() }),
  "auth.app_disconnected.v1": userEvent.extend({ clientId: z.string(), organizationId: z.uuid() }),
  "auth.account_deleted.v1": userEvent,

  "org.created.v1": z.object({ organizationId: z.uuid(), name: z.string() }),
  "org.deleted.v1": z.object({ organizationId: z.uuid() }),
  "org.member_added.v1": memberEvent,
  "org.member_removed.v1": memberEvent,
  "org.member_role_changed.v1": memberEvent.extend({ previousRole: z.string() }),
  "org.api_key_created.v1": z.object({
    apiKeyId: z.uuid(),
    name: z.string(),
    scopes: z.array(z.string()),
  }),
  "org.api_key_revoked.v1": z.object({ apiKeyId: z.uuid(), name: z.string() }),
  // Emitted by apps/webhooks.
  /**
   * The email provider says an address hard-bounced or its owner marked our mail as spam:
   * apps/notifications never emails it again.
   */
  "email.feedback_received.v1": z.object({
    provider: z.enum(["resend"]),
    kind: z.enum(["bounce", "complaint"]),
    address: z.email(),
  }),
  "stripe.event_received.v1": z.object({
    /** Our row in webhooks.inbound_event. */
    inboundEventId: z.uuid(),
    /** Stripe's event id (evt_...) and type (e.g. "customer.subscription.updated"). */
    stripeEventId: z.string(),
    type: z.string(),
    /** The Stripe event's `data.object`, as Stripe sent it. */
    object: z.record(z.string(), z.unknown()),
  }),
  "webhook.endpoint_created.v1": z.object({ endpointId: z.uuid(), url: z.url() }),
  "webhook.endpoint_updated.v1": z.object({
    endpointId: z.uuid(),
    changed: z.array(z.enum(["url", "description", "events", "enabled"])),
  }),
  "webhook.endpoint_deleted.v1": z.object({ endpointId: z.uuid(), url: z.url() }),
  "webhook.secret_rotated.v1": z.object({ endpointId: z.uuid() }),
  "webhook.endpoint_disabled.v1": z.object({
    endpointId: z.uuid(),
    url: z.url(),
    reason: z.enum(["failing"]),
  }),

  "org.invitation_sent.v1": z.object({
    organizationId: z.uuid(),
    invitationId: z.uuid(),
    email: z.email(),
    role: z.string(),
  }),
} as const;

export type EventName = keyof typeof events;
export type EventPayload<N extends EventName> = z.infer<(typeof events)[N]>;

export const eventNames = Object.keys(events) as [EventName, ...EventName[]];

/**
 * Events customers can receive on their webhook endpoints: product facts about their
 * organization. Account-security events stay internal (audit log only).
 */
export const webhookEvents = [
  "todo.created.v1",
  "todo.completed.v1",
  "todo.deleted.v1",
  "org.member_added.v1",
  "org.member_removed.v1",
] as const satisfies readonly EventName[];
export type WebhookEventName = (typeof webhookEvents)[number];

/**
 * An event as it travels from the outbox to consumers: the committed row, with its
 * payload still untyped (validate it with `events[name]` before use).
 *
 * The name is any well-formed event name, not only the ones this build knows: during a
 * rolling deploy a newer service can emit an event an older worker or consumer hasn't
 * heard of. The relay must pass it on rather than reject the batch (which would stall
 * every event behind it), and each consumer ignores names it doesn't handle.
 */
export const eventEnvelope = z.object({
  id: z.uuid(),
  name: z.string().regex(/^[a-z][a-z_]*(\.[a-z][a-z_]*)+\.v\d+$/),
  /** Ordering/partition key, usually the aggregate id. */
  key: z.string(),
  payload: z.unknown(),
  orgId: z.uuid().nullable(),
  actorId: z.uuid().nullable(),
  requestId: z.string().nullable(),
  occurredAt: z.iso.datetime({ offset: true }),
  /** The owning schema whose outbox the event came from. */
  source: z.string(),
});
export type EventEnvelope = z.infer<typeof eventEnvelope>;
