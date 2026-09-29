/**
 * Domain events that notify someone, mapped to notification templates. The event id is
 * the idempotency key, so a redelivered event notifies nobody twice.
 *
 * To notify on another event: route it here (`eventSubscribers["events-notifications"]`
 * in packages/jobs), add a template, and map it below.
 */
import { Processor, WorkerHost } from "@nestjs/bullmq";
import { type EventEnvelope, events } from "@repo/contracts/events";
import { type NotificationPayload, parseJob, queuePrefix } from "@repo/jobs";
import { runWithContext } from "@repo/nest-common";
import type { Job } from "bullmq";
import { Dispatcher } from "../dispatch/dispatcher";

function notificationFor(event: EventEnvelope): NotificationPayload | undefined {
  switch (event.name) {
    case "webhook.endpoint_disabled.v1": {
      if (!event.orgId) return undefined;
      const payload = events[event.name].parse(event.payload);
      return {
        template: "webhooks.endpoint-disabled",
        to: { orgId: event.orgId, roles: ["owner", "admin"] },
        data: { endpointId: payload.endpointId, url: payload.url },
      };
    }
    default:
      return undefined;
  }
}

@Processor("events-notifications", { concurrency: 10, prefix: queuePrefix("events-notifications") })
export class EventsProcessor extends WorkerHost {
  constructor(private readonly dispatcher: Dispatcher) {
    super();
  }

  async process(job: Job) {
    const { meta, payload: event } = parseJob("events-notifications", "event", job.data);
    const notification = notificationFor(event);
    if (!notification) return;
    await runWithContext({ ...meta, requestId: meta.requestId ?? `event:${event.id}` }, () =>
      this.dispatcher.dispatch(notification, event.id),
    );
  }
}
