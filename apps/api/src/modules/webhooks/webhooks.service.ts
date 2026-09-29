/**
 * Customer webhook endpoints: configuration rules, the signing secret, and hand-offs to
 * apps/webhooks (test events, replays). Every change is audited in the same transaction.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { Inject, Injectable, type OnApplicationShutdown } from "@nestjs/common";
import { WEBHOOK_ENDPOINT_LIMIT, type WebhookEndpoint } from "@repo/contracts/api";
import type { EventPayload, WebhookEventName } from "@repo/contracts/events";
import { type PageInput, toPage } from "@repo/contracts/pagination";
import { tenantTx } from "@repo/db";
import type { Producer } from "@repo/jobs";
import { AppError, type Database, InjectDatabase, keysFromEnv, SecretBox } from "@repo/nest-common";
import { env } from "../../env";
import { emitEvent } from "../../outbox";
import { BillingService } from "../billing";
import { assertDeliverableUrl } from "./webhook-url";
import { endpointColumns, WebhooksRepository } from "./webhooks.repository";

export const WEBHOOK_DELIVERIES = Symbol("WEBHOOK_DELIVERIES");

type EndpointRow = Awaited<ReturnType<WebhooksRepository["listEndpoints"]>>[number];

const toEndpoint = (row: EndpointRow): WebhookEndpoint => ({
  id: row.id,
  url: row.url,
  description: row.description,
  events: row.events as WebhookEventName[],
  createdAt: row.createdAt,
  disabledAt: row.disabledAt,
  disabledReason: row.disabledReason as WebhookEndpoint["disabledReason"],
});

/** Standard Webhooks secret format: whsec_ + base64 of 24 random bytes. */
const newSecret = () => `whsec_${randomBytes(24).toString("base64")}`;

type Changed = EventPayload<"webhook.endpoint_updated.v1">["changed"];

@Injectable()
export class WebhooksService implements OnApplicationShutdown {
  private readonly box = new SecretBox(keysFromEnv(env.ENCRYPTION_KEYS));

  constructor(
    @InjectDatabase() private readonly database: Database,
    private readonly repository: WebhooksRepository,
    @Inject(WEBHOOK_DELIVERIES) private readonly deliveries: Producer<"webhook-deliveries">,
    private readonly billing: BillingService,
  ) {}

  async listEndpoints(orgId: string) {
    return (await this.repository.listEndpoints(orgId)).map(toEndpoint);
  }

  async createEndpoint(
    orgId: string,
    userId: string,
    input: {
      url: string;
      description?: string | undefined;
      events?: WebhookEventName[] | undefined;
    },
  ) {
    // Existing endpoints keep working after a downgrade; new ones need the plan.
    await this.billing.require(orgId, "webhooks");
    await assertDeliverableUrl(input.url);
    const secret = newSecret();
    return tenantTx(this.database.write, orgId, async (tx) => {
      if ((await this.repository.countEndpoints(tx)) >= WEBHOOK_ENDPOINT_LIMIT) {
        throw new AppError("WEBHOOK_ENDPOINT_LIMIT", { params: { max: WEBHOOK_ENDPOINT_LIMIT } });
      }
      const endpoint = await tx.webhookEndpoint.create({
        data: {
          orgId,
          url: input.url,
          description: input.description ?? "",
          events: input.events ?? [],
          secret: this.box.encrypt(secret),
          createdById: userId,
        },
        select: endpointColumns,
      });
      await emitEvent(tx, "webhook.endpoint_created.v1", endpoint.id, {
        endpointId: endpoint.id,
        url: endpoint.url,
      });
      return { endpoint: toEndpoint(endpoint), secret };
    });
  }

  async updateEndpoint(
    orgId: string,
    input: {
      id: string;
      url?: string | undefined;
      description?: string | undefined;
      events?: WebhookEventName[] | undefined;
      enabled?: boolean | undefined;
    },
  ) {
    if (input.url !== undefined) await assertDeliverableUrl(input.url);
    return tenantTx(this.database.write, orgId, async (tx) => {
      const current = await this.repository.findEndpoint(tx, input.id);
      if (!current) throw new AppError("WEBHOOK_ENDPOINT_NOT_FOUND", { params: { id: input.id } });
      const changed: Changed = [];
      if (input.url !== undefined && input.url !== current.url) changed.push("url");
      if (input.description !== undefined && input.description !== current.description)
        changed.push("description");
      if (input.events !== undefined) changed.push("events");
      if (input.enabled !== undefined && input.enabled !== (current.disabledAt === null))
        changed.push("enabled");

      const endpoint = await tx.webhookEndpoint.update({
        where: { id: input.id },
        data: {
          ...(input.url !== undefined && { url: input.url }),
          ...(input.description !== undefined && { description: input.description }),
          ...(input.events !== undefined && { events: input.events }),
          ...(changed.includes("enabled") &&
            (input.enabled
              ? { disabledAt: null, disabledReason: null }
              : { disabledAt: new Date(), disabledReason: "manual" })),
        },
        select: endpointColumns,
      });
      if (changed.length > 0) {
        await emitEvent(tx, "webhook.endpoint_updated.v1", endpoint.id, {
          endpointId: endpoint.id,
          changed,
        });
      }
      return toEndpoint(endpoint);
    });
  }

  deleteEndpoint(orgId: string, id: string) {
    return tenantTx(this.database.write, orgId, async (tx) => {
      const current = await this.repository.findEndpoint(tx, id);
      if (!current) throw new AppError("WEBHOOK_ENDPOINT_NOT_FOUND", { params: { id } });
      await tx.webhookEndpoint.delete({ where: { id } });
      await emitEvent(tx, "webhook.endpoint_deleted.v1", id, { endpointId: id, url: current.url });
    });
  }

  rotateSecret(orgId: string, id: string) {
    const secret = newSecret();
    return tenantTx(this.database.write, orgId, async (tx) => {
      if (!(await this.repository.findEndpoint(tx, id))) {
        throw new AppError("WEBHOOK_ENDPOINT_NOT_FOUND", { params: { id } });
      }
      await tx.webhookEndpoint.update({
        where: { id },
        data: { secret: this.box.encrypt(secret) },
      });
      await emitEvent(tx, "webhook.secret_rotated.v1", id, { endpointId: id });
      return { secret };
    });
  }

  async sendTest(orgId: string, endpointId: string) {
    if (!(await this.repository.endpointExists(orgId, endpointId))) {
      throw new AppError("WEBHOOK_ENDPOINT_NOT_FOUND", { params: { id: endpointId } });
    }
    await this.deliveries.add(
      "send-test",
      { endpointId, orgId },
      { jobId: randomUUID(), meta: { orgId } },
    );
  }

  async listDeliveries(orgId: string, endpointId: string, page: PageInput) {
    if (!(await this.repository.endpointExists(orgId, endpointId))) {
      throw new AppError("WEBHOOK_ENDPOINT_NOT_FOUND", { params: { id: endpointId } });
    }
    const rows = await this.repository.listDeliveries(orgId, endpointId, page);
    return toPage(
      rows.map((row) => ({ ...row, status: row.status as "pending" | "succeeded" | "failed" })),
      page.limit,
    );
  }

  async redeliver(orgId: string, deliveryId: string) {
    if (!(await this.repository.deliveryExists(orgId, deliveryId))) {
      throw new AppError("WEBHOOK_DELIVERY_NOT_FOUND", { params: { id: deliveryId } });
    }
    await this.deliveries.add(
      "redeliver",
      { deliveryId, orgId },
      { jobId: randomUUID(), meta: { orgId } },
    );
  }

  async onApplicationShutdown() {
    await this.deliveries.close();
  }
}
