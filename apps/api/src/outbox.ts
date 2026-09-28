/**
 * Writes domain events to this service's transactional outbox (app.outbox_event).
 *
 *   await tenantTx(database.write, orgId, async (tx) => {
 *     const todo = await tx.todo.update(...);
 *     await emitEvent(tx, "todo.completed.v1", todo.id, { todoId: todo.id, title: todo.title });
 *   });
 *
 * The event is committed atomically with the change, so it can neither be lost (change
 * committed, event not) nor phantom (event sent, change rolled back). apps/worker relays
 * it to the queues that feed the audit log, webhooks and notifications. The payload is
 * validated against the event catalog in packages/contracts/src/events.ts, and the
 * actor, organization and request id come from the request context.
 */
import { type EventName, type EventPayload, events } from "@repo/contracts/events";
import type { Tx } from "@repo/db";
import { currentContext } from "@repo/nest-common";

/** Who and where, when the request context doesn't know (e.g. auth flows before a session exists). */
export interface EventOrigin {
  actorId?: string | null;
  orgId?: string | null;
}

export async function emitEvent<N extends EventName>(
  tx: Tx,
  name: N,
  key: string,
  payload: EventPayload<N>,
  origin: EventOrigin = {},
) {
  const context = currentContext();
  await tx.appOutboxEvent.create({
    data: {
      name,
      key,
      payload: events[name].parse(payload),
      orgId: origin.orgId !== undefined ? origin.orgId : (context?.orgId ?? null),
      actorId: origin.actorId !== undefined ? origin.actorId : (context?.userId ?? null),
      requestId: context?.requestId ?? null,
    },
  });
  // Wakes the relay immediately (delivered on commit); it also polls as a safety net.
  await tx.$executeRaw`SELECT pg_notify('outbox', 'app')`;
}

/** Any event with its matching payload, e.g. the result of a mapping function. */
export type AnyEvent = { [N in EventName]: { name: N; payload: EventPayload<N> } }[EventName];

/**
 * emitEvent for an `AnyEvent`. TypeScript can't relate a union's `name` to its `payload`
 * through a generic call, so the pairing is asserted here, once; `events[name].parse`
 * inside emitEvent still validates the payload at runtime.
 */
export function emitAnyEvent(tx: Tx, event: AnyEvent, key: string, origin: EventOrigin = {}) {
  return emitEvent(tx, event.name, key, event.payload as EventPayload<typeof event.name>, origin);
}
