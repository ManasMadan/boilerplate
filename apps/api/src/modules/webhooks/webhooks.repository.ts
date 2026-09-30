/**
 * Endpoint configuration and the delivery log (webhooks schema). apps/api may edit
 * endpoints and read deliveries; row-level security scopes both to the organization.
 */
import { Injectable } from "@nestjs/common";
import type { PageInput } from "@repo/contracts/pagination";
import { type Prisma, type Tx, withTenant } from "@repo/db";
import { type Database, InjectDatabase } from "@repo/nest-common";

const endpointColumns = {
  id: true,
  url: true,
  description: true,
  events: true,
  createdAt: true,
  disabledAt: true,
  disabledReason: true,
} as const;

@Injectable()
export class WebhooksRepository {
  constructor(@InjectDatabase() private readonly database: Database) {}

  listEndpoints(orgId: string) {
    return withTenant(this.database.read, orgId).webhookEndpoint.findMany({
      orderBy: { createdAt: "asc" },
      select: endpointColumns,
    });
  }

  countEndpoints(tx: Tx) {
    return tx.webhookEndpoint.count();
  }

  findEndpoint(tx: Tx, id: string) {
    return tx.webhookEndpoint.findUnique({ where: { id }, select: endpointColumns });
  }

  createEndpoint(
    tx: Tx,
    data: {
      orgId: string;
      url: string;
      description: string;
      events: string[];
      secret: string;
      createdById: string;
    },
  ) {
    return tx.webhookEndpoint.create({ data, select: endpointColumns });
  }

  updateEndpoint(tx: Tx, id: string, data: Prisma.WebhookEndpointUpdateInput) {
    return tx.webhookEndpoint.update({ where: { id }, data, select: endpointColumns });
  }

  deleteEndpoint(tx: Tx, id: string) {
    return tx.webhookEndpoint.delete({ where: { id } });
  }

  findSecret(tx: Tx, id: string) {
    return tx.webhookEndpoint.findUnique({ where: { id }, select: { secret: true } });
  }

  setSecret(
    tx: Tx,
    id: string,
    data: { secret: string; previousSecret: string; previousSecretExpiresAt: Date },
  ) {
    return tx.webhookEndpoint.update({ where: { id }, data });
  }

  endpointExists(orgId: string, id: string) {
    return withTenant(this.database.read, orgId)
      .webhookEndpoint.count({ where: { id } })
      .then((count) => count > 0);
  }

  listDeliveries(orgId: string, endpointId: string, { limit, cursor }: PageInput) {
    return withTenant(this.database.read, orgId).webhookDelivery.findMany({
      where: { endpointId, ...(cursor && { id: { lt: cursor } }) },
      orderBy: { id: "desc" },
      take: limit + 1,
      select: {
        id: true,
        eventName: true,
        status: true,
        attempts: true,
        lastStatus: true,
        lastError: true,
        lastAttemptAt: true,
        createdAt: true,
      },
    });
  }

  deliveryExists(orgId: string, id: string) {
    return withTenant(this.database.read, orgId)
      .webhookDelivery.count({ where: { id } })
      .then((count) => count > 0);
  }
}
