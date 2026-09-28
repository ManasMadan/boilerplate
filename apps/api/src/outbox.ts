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

export async function emitEvent<N extends EventName>(
  tx: Tx,
  name: N,
  key: string,
  payload: EventPayload<N>,
) {
  const context = currentContext();
  await tx.appOutboxEvent.create({
    data: {
      name,
      key,
      payload: events[name].parse(payload),
      orgId: context?.orgId ?? null,
      actorId: context?.userId ?? null,
      requestId: context?.requestId ?? null,
    },
  });
  // Wakes the relay immediately (delivered on commit); it also polls as a safety net.
  await tx.$executeRaw`SELECT pg_notify('outbox', 'app')`;
}
