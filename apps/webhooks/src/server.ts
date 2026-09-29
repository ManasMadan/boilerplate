/**
 * Builds the webhooks service: health checks, inbound provider routes, and the delivery
 * workers (registered by the modules). main.ts starts it; integration tests build it
 * in-process.
 */
import { createServer, DATABASE, type Database } from "@repo/nest-common";
import { AppModule } from "./app.module";
import { env } from "./env";
import { mountStripe } from "./inbound/stripe.routes";

export function createWebhooksServer() {
  return createServer(AppModule, {
    service: "webhooks",
    logLevel: env.LOG_LEVEL,
    trustedProxies: env.TRUSTED_PROXIES,
    corsOrigins: [],
    async configure(app) {
      mountStripe(
        app.getHttpAdapter().getInstance(),
        app.get<Database>(DATABASE),
        env.STRIPE_WEBHOOK_SECRET,
      );
    },
  });
}
