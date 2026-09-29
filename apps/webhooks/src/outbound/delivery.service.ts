/**
 * Sends one delivery attempt and records the outcome.
 *
 * The request goes through safeFetch (no private addresses, pinned DNS, capped time and
 * response size), signed per Standard Webhooks. Any 2xx is success. Anything else is a
 * failure BullMQ retries on the delivery schedule. When the last retry fails, and the
 * endpoint hasn't succeeded for WEBHOOK_AUTO_DISABLE_HOURS, the endpoint is disabled
 * and `webhook.endpoint_disabled.v1` tells the organization's admins (notifications).
 */
import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { tenantTx, withTenant } from "@repo/db";
import {
  type Database,
  InjectDatabase,
  InjectPinoLogger,
  keysFromEnv,
  PinoLogger,
  SecretBox,
  safeFetch,
} from "@repo/nest-common";
import { env } from "../env";
import { emitEvent } from "../outbox";
import { signatureHeaders } from "./signing";

export type AttemptResult = "succeeded" | "retry" | "failed" | "skipped";

const USER_AGENT = "Boilerplate-Webhooks/1.0 (+https://www.standardwebhooks.com)";
const HOUR = 3_600_000;

@Injectable()
export class DeliveryService {
  private readonly box = new SecretBox(keysFromEnv(env.ENCRYPTION_KEYS));

  constructor(
    @InjectDatabase() private readonly database: Database,
    @InjectPinoLogger(DeliveryService.name) private readonly log: PinoLogger,
  ) {}

  /** One attempt. `isLastAttempt`: no retry follows if this one fails. */
  async attempt(orgId: string, deliveryId: string, isLastAttempt: boolean): Promise<AttemptResult> {
    const tenant = withTenant(this.database.write, orgId);
    const delivery = await tenant.webhookDelivery.findUnique({
      where: { id: deliveryId },
      include: { endpoint: { select: { id: true, url: true, secret: true, disabledAt: true } } },
    });
    if (delivery?.status !== "pending") return "skipped";
    if (delivery.endpoint.disabledAt) {
      await tenant.webhookDelivery.update({
        where: { id: deliveryId },
        data: { status: "failed", lastError: "endpoint disabled" },
      });
      return "skipped";
    }

    const started = performance.now();
    let status: number | undefined;
    let error: string | undefined;
    try {
      const response = await safeFetch(delivery.endpoint.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": USER_AGENT,
          ...signatureHeaders(
            this.box.decrypt(delivery.endpoint.secret),
            delivery.eventId,
            delivery.body,
          ),
        },
        body: delivery.body,
        timeoutMs: env.WEBHOOK_TIMEOUT_MS,
        maxResponseBytes: 64 * 1024,
        allowHttp: env.NODE_ENV !== "production",
        allowedPrivateAddresses: env.WEBHOOK_ALLOWED_PRIVATE_ADDRESSES,
      });
      status = response.status;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
    const succeeded = status !== undefined && status >= 200 && status < 300;
    const outcome: AttemptResult = succeeded ? "succeeded" : isLastAttempt ? "failed" : "retry";

    await tenant.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        attempts: { increment: 1 },
        lastAttemptAt: new Date(),
        lastStatus: status ?? null,
        lastError: succeeded ? null : (error ?? `HTTP ${status}`),
        lastDurationMs: Math.round(performance.now() - started),
        ...(outcome === "succeeded" && { status: "succeeded", succeededAt: new Date() }),
        ...(outcome === "failed" && { status: "failed" }),
      },
    });
    if (outcome === "failed")
      await this.disableIfFailing(orgId, delivery.endpoint.id, delivery.endpoint.url);
    return outcome;
  }

  /** Puts a finished delivery back in the queue's hands (admin replay). */
  async reset(orgId: string, deliveryId: string) {
    const { count } = await withTenant(this.database.write, orgId).webhookDelivery.updateMany({
      where: { id: deliveryId, status: { not: "pending" } },
      data: { status: "pending" },
    });
    return count === 1;
  }

  /** Creates a delivery of a test event to one endpoint; returns its id. */
  async createTest(orgId: string, endpointId: string) {
    const eventId = randomUUID();
    const body = JSON.stringify({
      type: "webhook.test",
      timestamp: new Date().toISOString(),
      data: { message: "This is a test event from your webhook settings." },
    });
    const delivery = await withTenant(this.database.write, orgId).webhookDelivery.create({
      data: { endpointId, orgId, eventId, eventName: "webhook.test", body },
      select: { id: true },
    });
    return delivery.id;
  }

  private async disableIfFailing(orgId: string, endpointId: string, url: string) {
    await tenantTx(this.database.write, orgId, async (tx) => {
      const lastSuccess = await tx.webhookDelivery.findFirst({
        where: { endpointId, status: "succeeded" },
        orderBy: { succeededAt: "desc" },
        select: { succeededAt: true },
      });
      const firstFailureSince = await tx.webhookDelivery.findFirst({
        where: {
          endpointId,
          status: "failed",
          ...(lastSuccess?.succeededAt && { createdAt: { gt: lastSuccess.succeededAt } }),
        },
        orderBy: { createdAt: "asc" },
        select: { createdAt: true },
      });
      const failingFor = firstFailureSince ? Date.now() - firstFailureSince.createdAt.getTime() : 0;
      if (failingFor < env.WEBHOOK_AUTO_DISABLE_HOURS * HOUR) return;

      const { count } = await tx.webhookEndpoint.updateMany({
        where: { id: endpointId, disabledAt: null },
        data: { disabledAt: new Date(), disabledReason: "failing" },
      });
      if (count === 0) return;
      await emitEvent(
        tx,
        "webhook.endpoint_disabled.v1",
        endpointId,
        { endpointId, url, reason: "failing" },
        { orgId, actorId: null },
      );
      this.log.warn({ endpointId, orgId }, "webhook endpoint disabled after failing continuously");
    });
  }
}
