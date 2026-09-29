---
name: swap-event-transport
description: Move domain events from BullMQ queues to a log-based broker (Kafka, Redpanda, NATS JetStream). Use when event volume, ordering, replay or fan-out outgrows Redis queues, or the user asks about changing the event bus.
---

# Swap the event transport

- **Interface:** `EventBus` (abstract class, `publish(events): Promise<void>`) in
  `apps/worker/src/outbox/event-bus.ts`.
- **Today:** `BullMqEventBus` copies each event into every queue whose filter in
  `eventSubscribers` (`packages/jobs/src/queues.ts`) accepts it, with jobId = event id.
  At least once, unordered.
- **Bound in:** `apps/worker/src/outbox/outbox.module.ts`.
- **Env:** none beyond `REDIS_URL` today.

## Swap

1. A class extending `EventBus` that produces each `EventEnvelope` to one topic keyed by
   `event.key` (per-aggregate order), idempotently (the relay may republish a batch after
   a crash). Bind it in `outbox.module.ts`. The relay, `emitEvent` and every producer
   stay as they are.
2. Consumers are what move. Each is a BullMQ `@Processor` on an `events-*` queue today:
   `events-audit` (`apps/worker/src/audit/audit.processor.ts`), `events-realtime`
   (`apps/worker/src/realtime/realtime.processor.ts`), `events-webhooks`
   (`apps/webhooks/src/outbound/fanout.processor.ts`), `events-notifications`
   (`apps/notifications/src/events/events.processor.ts`), `events-billing`
   (`apps/api/src/modules/billing/billing-events.processor.ts`). Each becomes a consumer
   group applying its `eventSubscribers` filter itself, still deduping on the event id.
   Moving one consumer at a time works if the bus publishes to both for a while.
3. The broker's address in `apps/worker/src/env.ts` and each consumer's `src/env.ts`,
   `.env.example`, `docs/environment.md`; KEDA triggers in `deploy/charts/stack` change
   from queue length to consumer lag.

## Tests

The `outbox relay` tests in `apps/worker/test/worker.integration.test.ts`, and each
consumer's integration suite. A broker needs a local container for tests; add it to
`docker-compose.yml` with a memory limit like the others.
