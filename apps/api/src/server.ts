/**
 * Builds the API application: Nest modules, better-auth under /api/auth, and the oRPC
 * router under /rpc and /api/v1. main.ts starts it; integration tests build it in-process.
 */
import { createServer } from "@repo/nest-common";
import { Logger } from "nestjs-pino";
import { AppModule } from "./app.module";
import { AUTH, type Auth } from "./auth/auth.module";
import { mountAuth } from "./auth/auth.routes";
import { env } from "./env";
import { createProcedures } from "./rpc/procedures";
import { createRouter } from "./rpc/router";
import { mountRpc } from "./rpc/rpc.routes";

export function createApiServer() {
  return createServer(AppModule, {
    service: "api",
    logLevel: env.LOG_LEVEL,
    trustedProxies: env.TRUSTED_PROXIES,
    corsOrigins: [env.WEB_URL],
    async configure(app) {
      const fastify = app.getHttpAdapter().getInstance();
      const auth = app.get<Auth>(AUTH);
      const logger = app.get(Logger);
      mountAuth(fastify, auth, env.BETTER_AUTH_URL);
      await mountRpc(fastify, createRouter(createProcedures(auth), app), {
        logError: (error) => logger.error(error, "unhandled error in procedure"),
        publicUrl: env.BETTER_AUTH_URL,
        release: env.RELEASE,
        exposeDocs: env.NODE_ENV !== "production",
      });
    },
  });
}
