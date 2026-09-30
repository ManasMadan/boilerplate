/**
 * Data access for billing: the subscription rows mirrored from Stripe and each
 * organization's Stripe customer (tenant tables, scoped by withTenant/tenantTx), plus
 * the organization and member counts billing reads.
 */
import { Injectable } from "@nestjs/common";
import { PAID_STATUSES } from "@repo/contracts/billing";
import { type Tx, withTenant } from "@repo/db";
import { type Database, InjectDatabase } from "@repo/nest-common";

const OVER = ["canceled", "incomplete_expired"];

export interface SubscriptionData {
  plan: string;
  status: string;
  priceId: string;
  interval: string;
  quantity: number;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  trialEnd: Date | null;
}

@Injectable()
export class BillingRepository {
  constructor(@InjectDatabase() private readonly database: Database) {}

  /** The subscription that decides the plan: the newest one that isn't over. */
  current(orgId: string) {
    return withTenant(this.database.read, orgId).subscription.findFirst({
      where: { orgId, status: { notIn: OVER } },
      orderBy: { createdAt: "desc" },
    });
  }

  /** Every subscription that isn't over (normally at most one). */
  live(orgId: string) {
    return withTenant(this.database.read, orgId).subscription.findMany({
      where: { orgId, status: { notIn: OVER } },
      select: { id: true },
    });
  }

  /** Whether the organization has ever had a subscription (a trial is once only). */
  hadSubscription(orgId: string) {
    return withTenant(this.database.read, orgId)
      .subscription.count({ where: { orgId } })
      .then((count) => count > 0);
  }

  async saveSubscription(tx: Tx, id: string, orgId: string, data: SubscriptionData) {
    await tx.subscription.upsert({
      where: { id },
      create: { id, orgId, ...data },
      update: data,
    });
  }

  /** The organization's paid subscriptions other than `id`. */
  otherPaid(tx: Tx, orgId: string, id: string) {
    return tx.subscription.findMany({
      where: { orgId, id: { not: id }, status: { in: [...PAID_STATUSES] } },
      select: { id: true },
    });
  }

  customer(orgId: string) {
    return withTenant(this.database.read, orgId).billingCustomer.findUnique({
      where: { orgId },
    });
  }

  /** Records the customer unless one is already recorded (concurrent first calls agree). */
  async saveCustomer(orgId: string, stripeCustomerId: string) {
    await withTenant(this.database.write, orgId).billingCustomer.createMany({
      data: [{ orgId, stripeCustomerId }],
      skipDuplicates: true,
    });
  }

  memberCount(orgId: string) {
    return this.database.read.member.count({ where: { organizationId: orgId } });
  }

  organizationName(orgId: string) {
    return this.database.read.organization.findUniqueOrThrow({
      where: { id: orgId },
      select: { name: true },
    });
  }

  organization(orgId: string) {
    return this.database.read.organization.findUnique({
      where: { id: orgId },
      select: { id: true, name: true },
    });
  }
}
