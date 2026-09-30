/**
 * Domain events that notify someone, mapped to notification templates. The event id is
 * the idempotency key, so a redelivered event notifies nobody twice.
 *
 * To notify on another event: route it here (`eventSubscribers["events-notifications"]`
 * in packages/jobs), add a template, and map it below.
 *
 * Email feedback (a provider's bounce or spam complaint, from apps/webhooks) goes to the
 * suppression list instead, so the address is never emailed again.
 */
import { Processor } from "@nestjs/bullmq";
import { type EventEnvelope, events } from "@repo/contracts/events";
import { type NotificationPayload, notificationPayload, parseJob, queuePrefix } from "@repo/jobs";
import { JobProcessor, runWithContext } from "@repo/nest-common";
import type { Job } from "bullmq";
import { Dispatcher } from "../dispatch/dispatcher";
import { DeliveryPolicy } from "../dispatch/policy";

function notificationFor(event: EventEnvelope): NotificationPayload | undefined {
  switch (event.name) {
    // Asked for in the transaction of the change it's about (security alerts).
    case "notification.requested.v1":
      return notificationPayload.parse(events[event.name].parse(event.payload).notification);
    case "webhook.endpoint_disabled.v1": {
      if (!event.orgId) return undefined;
      const payload = events[event.name].parse(event.payload);
      return {
        template: "webhooks.endpoint-disabled",
        to: { orgId: event.orgId, roles: ["owner", "admin"] },
        data: { endpointId: payload.endpointId, url: payload.url },
      };
    }
    case "org.api_key_created.v1":
    case "webhook.endpoint_created.v1": {
      if (!event.orgId) return undefined;
      const apiKey = event.name === "org.api_key_created.v1";
      const label = apiKey
        ? events["org.api_key_created.v1"].parse(event.payload).name
        : events["webhook.endpoint_created.v1"].parse(event.payload).url;
      return {
        template: "workspace.access-created",
        to: { orgId: event.orgId, roles: ["owner", "admin"] },
        data: { kind: apiKey ? "api-key" : "webhook-endpoint", label },
      };
    }
    default:
      return undefined;
  }
}

@Processor("events-notifications", { concurrency: 10, prefix: queuePrefix("events-notifications") })
export class EventsProcessor extends JobProcessor {
  constructor(
    private readonly dispatcher: Dispatcher,
    private readonly policy: DeliveryPolicy,
  ) {
    super();
  }

  async process(job: Job) {
    const { meta, payload: event } = parseJob("events-notifications", "event", job.data);
    if (event.name === "email.feedback_received.v1") {
      const { address, kind } = events[event.name].parse(event.payload);
      await this.policy.suppress("email", address, kind);
      return;
    }
    const notification = notificationFor(event);
    if (!notification) return;
    await runWithContext({ ...meta, requestId: meta.requestId ?? `event:${event.id}` }, () =>
      this.dispatcher.dispatch(notification, event.id),
    );
  }
}
