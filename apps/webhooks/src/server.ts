/**
 * Builds the webhooks service: health checks, inbound provider routes, and the delivery
 * workers (registered by the modules). main.ts starts it; integration tests build it
 * in-process.
 */
import { createServer, DATABASE, type Database } from "@repo/nest-common";
import { AppModule } from "./app.module";
import { env } from "./env";
import { mountResend } from "./inbound/resend.routes";
import { mountStripe } from "./inbound/stripe.routes";

export function createWebhooksServer() {
  return createServer(AppModule, {
    service: "webhooks",
    logLevel: env.LOG_LEVEL,
    trustedProxies: env.TRUSTED_PROXIES,
    loadShedding: env.LOAD_SHEDDING,
    corsOrigins: [],
    async configure(app) {
      const fastify = app.getHttpAdapter().getInstance();
      const database = app.get<Database>(DATABASE);
      mountStripe(fastify, database, env.STRIPE_WEBHOOK_SECRET);
      mountResend(fastify, database, env.RESEND_WEBHOOK_SECRET);
    },
  });
}
