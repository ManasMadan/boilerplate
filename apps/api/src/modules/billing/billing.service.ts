/**
 * Billing per organization (see packages/contracts billing for plans).
 *
 * Stripe is the source of truth. Whenever anything about a subscription changes, its
 * webhook reaches `sync`, which reads the subscription back from Stripe and overwrites
 * our row, so duplicated or out-of-order events can't leave stale state behind. Rows are
 * matched to the organization by the `orgId` we put in the customer's and subscription's
 * metadata when checkout starts.
 *
 * With billing off (no Stripe configured), every organization has every entitlement.
 */
import { Inject, Injectable } from "@nestjs/common";
import type { BillingOverview } from "@repo/contracts/api";
import {
  type BillingInterval,
  type Entitlement,
  type Entitlements,
  PAID_STATUSES,
  type PlanName,
  plans,
  type SubscriptionStatus,
  unlimited,
} from "@repo/contracts/billing";
import { tenantTx, withTenant } from "@repo/db";
import {
  AppError,
  type Database,
  InjectDatabase,
  InjectPinoLogger,
  PinoLogger,
} from "@repo/nest-common";
import type Stripe from "stripe";
import { env } from "../../env";
import { STRIPE } from "./stripe";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class BillingService {
  constructor(
    @Inject(STRIPE) private readonly stripe: Stripe | null,
    @InjectDatabase() private readonly database: Database,
    @InjectPinoLogger(BillingService.name) private readonly log: PinoLogger,
  ) {}

  get enabled() {
    return this.stripe !== null;
  }

  private get client() {
    if (!this.stripe) throw new AppError("FEATURE_DISABLED", { params: { feature: "billing" } });
    return this.stripe;
  }

  private prices(): Record<string, { plan: PlanName; interval: BillingInterval }> {
    return {
      [env.STRIPE_PRICE_PRO_MONTHLY as string]: { plan: "pro", interval: "month" },
      [env.STRIPE_PRICE_PRO_YEARLY as string]: { plan: "pro", interval: "year" },
    };
  }

  /** The subscription that decides the plan: the newest one that isn't over. */
  private async current(orgId: string) {
    return withTenant(this.database.read, orgId).subscription.findFirst({
      where: { orgId, status: { notIn: ["canceled", "incomplete_expired"] } },
      orderBy: { createdAt: "desc" },
    });
  }

  async plan(orgId: string): Promise<PlanName> {
    if (!this.enabled) return "pro";
    const subscription = await this.current(orgId);
    return subscription && PAID_STATUSES.includes(subscription.status as SubscriptionStatus)
      ? (subscription.plan as PlanName)
      : "free";
  }

  async entitlements(orgId: string): Promise<Entitlements> {
    if (!this.enabled) return unlimited;
    return plans[await this.plan(orgId)].entitlements;
  }

  /** Throws ENTITLEMENT_REQUIRED unless the organization's plan includes `entitlement`. */
  async require(orgId: string, entitlement: Exclude<Entitlement, "members">) {
    if (!(await this.entitlements(orgId))[entitlement]) {
      throw new AppError("ENTITLEMENT_REQUIRED", { params: { entitlement } });
    }
  }

  private memberCount(orgId: string) {
    return this.database.read.member.count({ where: { organizationId: orgId } });
  }

  async overview(orgId: string): Promise<BillingOverview> {
    const [plan, entitlements, members, subscription] = await Promise.all([
      this.plan(orgId),
      this.entitlements(orgId),
      this.memberCount(orgId),
      this.enabled ? this.current(orgId) : null,
    ]);
    return {
      enabled: this.enabled,
      plan,
      entitlements,
      members,
      subscription: subscription && {
        status: subscription.status as SubscriptionStatus,
        interval: subscription.interval as BillingInterval,
        seats: subscription.quantity,
        currentPeriodEnd: subscription.currentPeriodEnd,
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        trialEnd: subscription.trialEnd,
      },
    };
  }

  async checkout(orgId: string, interval: BillingInterval) {
    const stripe = this.client;
    const current = await this.current(orgId);
    if (current && PAID_STATUSES.includes(current.status as SubscriptionStatus)) {
      throw new AppError("ALREADY_SUBSCRIBED");
    }
    const customer = await this.customer(orgId);
    const hadOne = await withTenant(this.database.read, orgId).subscription.count({
      where: { orgId },
    });
    const price = interval === "month" ? env.STRIPE_PRICE_PRO_MONTHLY : env.STRIPE_PRICE_PRO_YEARLY;
    const settings = new URL("/settings/billing", env.WEB_URL);
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer,
      client_reference_id: orgId,
      line_items: [
        { price: price as string, quantity: Math.max(1, await this.memberCount(orgId)) },
      ],
      subscription_data: {
        metadata: { orgId },
        // One free trial per organization.
        ...(env.STRIPE_TRIAL_DAYS > 0 &&
          hadOne === 0 && { trial_period_days: env.STRIPE_TRIAL_DAYS }),
      },
      allow_promotion_codes: true,
      success_url: `${settings.toString()}?checkout=done`,
      cancel_url: settings.toString(),
    });
    if (!session.url) throw new Error("Stripe returned a checkout session without a URL");
    return { url: session.url };
  }

  async portal(orgId: string) {
    const stripe = this.client;
    const row = await withTenant(this.database.read, orgId).billingCustomer.findUnique({
      where: { orgId },
    });
    if (!row) throw new AppError("NO_SUBSCRIPTION");
    const session = await stripe.billingPortal.sessions.create({
      customer: row.stripeCustomerId,
      return_url: new URL("/settings/billing", env.WEB_URL).toString(),
    });
    return { url: session.url };
  }

  async invoices(orgId: string) {
    const stripe = this.client;
    const row = await withTenant(this.database.read, orgId).billingCustomer.findUnique({
      where: { orgId },
    });
    if (!row) return [];
    const list = await stripe.invoices.list({ customer: row.stripeCustomerId, limit: 24 });
    return list.data.map((invoice) => ({
      id: invoice.id as string,
      number: invoice.number ?? null,
      status: invoice.status ?? "draft",
      amount: invoice.amount_due,
      currency: invoice.currency,
      createdAt: new Date(invoice.created * 1000),
      url: invoice.hosted_invoice_url ?? null,
    }));
  }

  /** The organization's Stripe customer, created once (concurrent first calls agree). */
  private async customer(orgId: string) {
    const stripe = this.client;
    const existing = await withTenant(this.database.read, orgId).billingCustomer.findUnique({
      where: { orgId },
    });
    if (existing) return existing.stripeCustomerId;
    const org = await this.database.read.organization.findUniqueOrThrow({
      where: { id: orgId },
      select: { name: true },
    });
    const created = await stripe.customers.create(
      { name: org.name, metadata: { orgId } },
      // The same organization always maps to the same customer, even when two admins
      // click at once or a request is retried.
      { idempotencyKey: `customer-${orgId}` },
    );
    await withTenant(this.database.write, orgId).billingCustomer.createMany({
      data: [{ orgId, stripeCustomerId: created.id }],
      skipDuplicates: true,
    });
    return created.id;
  }

  /** Mirrors a subscription from Stripe. Unknown prices and organizations are ignored. */
  async sync(subscriptionId: string) {
    const stripe = this.client;
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    const orgId = subscription.metadata.orgId;
    const item = subscription.items.data[0];
    const price = item && this.prices()[item.price.id];
    if (!orgId || !UUID.test(orgId) || !item || !price) {
      this.log.warn({ subscriptionId }, "ignoring a subscription that isn't ours");
      return;
    }
    const org = await this.database.read.organization.findUnique({
      where: { id: orgId },
      select: { id: true },
    });
    if (!org) return; // deleted meanwhile
    const data = {
      plan: price.plan,
      status: subscription.status,
      priceId: item.price.id,
      interval: price.interval,
      quantity: item.quantity ?? 1,
      currentPeriodEnd: new Date(item.current_period_end * 1000),
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      trialEnd: subscription.trial_end ? new Date(subscription.trial_end * 1000) : null,
    };
    await tenantTx(this.database.write, orgId, (tx) =>
      tx.subscription.upsert({
        where: { id: subscription.id },
        create: { id: subscription.id, orgId, ...data },
        update: data,
      }),
    );
  }

  /** Paid plans are per seat: keeps the subscription's quantity at the member count. */
  async syncSeats(orgId: string) {
    const stripe = this.client;
    const current = await this.current(orgId);
    if (!current || !PAID_STATUSES.includes(current.status as SubscriptionStatus)) return;
    const seats = Math.max(1, await this.memberCount(orgId));
    if (seats === current.quantity) return;
    const subscription = await stripe.subscriptions.retrieve(current.id);
    const item = subscription.items.data[0];
    if (!item || item.quantity === seats) return;
    await stripe.subscriptions.update(
      current.id,
      { items: [{ id: item.id, quantity: seats }], proration_behavior: "create_prorations" },
      { idempotencyKey: `seats-${current.id}-${seats}-${item.quantity}` },
    );
  }

  /** Before an organization is deleted: nothing may keep charging for it. */
  async cancelFor(orgId: string) {
    if (!this.stripe) return;
    const live = await withTenant(this.database.read, orgId).subscription.findMany({
      where: { orgId, status: { notIn: ["canceled", "incomplete_expired"] } },
      select: { id: true },
    });
    for (const { id } of live) {
      await this.stripe.subscriptions.cancel(id, {}, { idempotencyKey: `cancel-${id}` });
    }
  }

  /** The organization a subscription belongs to (by its metadata), if it still exists. */
  async orgFor(subscriptionId: string) {
    const subscription = await this.client.subscriptions.retrieve(subscriptionId);
    const orgId = subscription.metadata.orgId;
    if (!orgId || !UUID.test(orgId)) return null;
    return this.database.read.organization.findUnique({
      where: { id: orgId },
      select: { id: true, name: true },
    });
  }
}
