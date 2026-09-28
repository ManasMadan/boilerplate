/**
 * Domain events: facts that happened, published through the transactional outbox and
 * consumed by the audit log, customer webhooks and notifications.
 *
 * Names are versioned (`todo.completed.v1`). Adding an optional field is compatible;
 * anything else is a new version, published alongside the old one until every
 * consumer has moved. Consumers must be idempotent (events are delivered at least once)
 * and must not depend on order.
 */
import { z } from "zod";

const todoEvent = z.object({ todoId: z.uuid(), title: z.string() });

export const events = {
  "todo.created.v1": todoEvent,
  "todo.completed.v1": todoEvent,
  "todo.deleted.v1": z.object({ todoId: z.uuid() }),
  "user.signed_up.v1": z.object({ userId: z.uuid() }),
  "auth.session_revoked.v1": z.object({ userId: z.uuid(), sessionId: z.string() }),
} as const;

export type EventName = keyof typeof events;
export type EventPayload<N extends EventName> = z.infer<(typeof events)[N]>;
