/**
 * Billing's share of domain events (`eventSubscribers["events-billing"]`):
 *
 *   - Stripe's (received and verified by apps/webhooks): any change to a subscription
 *     re-syncs it; a failed renewal also tells the organization's owners and admins;
 *   - membership changes: a paid plan's seat count follows the member count.
 *
 * Handlers are idempotent (syncs overwrite, seat updates are keyed, notifications use
 * the event id), so a redelivered event is harmless. It runs in the API because the API
 * owns the billing schema and holds the Stripe key; at scale it moves to its own worker
 * deployment unchanged.
 */
import { Processor } from "@nestjs/bullmq";
import { events } from "@repo/contracts/events";
import { parseJob, queuePrefix } from "@repo/jobs";
import { JobProcessor, runWithContext } from "@repo/nest-common";
import type { Job } from "bullmq";
import * as z from "zod";
import { env } from "../../env";
import { type CriticalNotifications, InjectCriticalNotifications } from "../../notifications";
import { BillingService } from "./billing.service";

// Stripe events whose object is, or points at, a subscription.
const SUBSCRIPTION_EVENTS = new Set([
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
]);

/**
 * What a failed payment's alert needs from the invoice. Parsed, not defaulted: an alert
 * saying "a payment of 0 USD failed" is worse than a job that fails loudly.
 */
const failedInvoice = z.object({
  amount_due: z.number().int().nonnegative(),
  currency: z.string().length(3),
});

interface StripeObject {
  id?: string;
  subscription?: string | null;
  parent?: { subscription_details?: { subscription?: string } | null } | null;
}

@Processor("events-billing", { concurrency: 5, prefix: queuePrefix("events-billing") })
export class BillingEventsProcessor extends JobProcessor {
  constructor(
    private readonly billing: BillingService,
    @InjectCriticalNotifications() private readonly notifications: CriticalNotifications,
  ) {
    super();
  }

  async process(job: Job) {
    const { meta, payload: event } = parseJob("events-billing", "event", job.data);
    if (!this.billing.enabled) return;
    await runWithContext({ ...meta, requestId: meta.requestId ?? `event:${event.id}` }, () =>
      this.handle(event.id, event.name, event.payload),
    );
  }

  private async handle(eventId: string, name: string, raw: unknown) {
    if (name === "org.member_added.v1" || name === "org.member_removed.v1") {
      const { organizationId } = events[name].parse(raw);
      await this.billing.syncSeats(organizationId);
      return;
    }
    if (name !== "stripe.event_received.v1") return;
    const { type, object } = events[name].parse(raw);
    const stripeObject = object as StripeObject;
    const subscriptionId = SUBSCRIPTION_EVENTS.has(type)
      ? stripeObject.id
      : type === "checkout.session.completed"
        ? stripeObject.subscription
        : type.startsWith("invoice.")
          ? stripeObject.parent?.subscription_details?.subscription
          : undefined;
    if (!subscriptionId) return;
    await this.billing.sync(subscriptionId);

    if (type === "invoice.payment_failed") {
      const invoice = failedInvoice.parse(object);
      const org = await this.billing.orgFor(subscriptionId);
      if (!org) return;
      await this.notifications.add(
        "send",
        {
          template: "billing.payment-failed",
          to: { orgId: org.id, roles: ["owner", "admin"] },
          data: {
            organizationName: org.name,
            amount: invoice.amount_due,
            currency: invoice.currency.toUpperCase(),
            billingUrl: new URL("/settings/billing", env.WEB_URL).toString(),
          },
        },
        // One alert per failed payment, however often the event is delivered.
        { jobId: `payment-failed-${eventId}` },
      );
    }
  }
}
