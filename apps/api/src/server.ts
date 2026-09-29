/**
 * Builds the API application: Nest modules, better-auth under /api/auth, and the oRPC
 * router under /rpc and /api/v1. main.ts starts it; integration tests build it in-process.
 */
import { createServer } from "@repo/nest-common";
import { Logger } from "nestjs-pino";
import { AppModule } from "./app.module";
import { AUTH, type Auth, MEMBERSHIPS, type Memberships } from "./auth/auth.module";
import { mountAuth } from "./auth/auth.routes";
import { env } from "./env";
import { FilesService, mountFileContent } from "./modules/files";
import { mountOneClickUnsubscribe, NotificationsService } from "./modules/notifications";
import { createProcedures } from "./rpc/procedures";
import { createRouter } from "./rpc/router";
import { mountRpc } from "./rpc/rpc.routes";

export function createApiServer() {
  return createServer(AppModule, {
    service: "api",
    logLevel: env.LOG_LEVEL,
    trustedProxies: env.TRUSTED_PROXIES,
    loadShedding: env.LOAD_SHEDDING,
    corsOrigins: [env.WEB_URL],
    async configure(app) {
      const fastify = app.getHttpAdapter().getInstance();
      const auth = app.get<Auth>(AUTH);
      const memberships = app.get<Memberships>(MEMBERSHIPS);
      const logger = app.get(Logger);
      mountAuth(fastify, auth, env.BETTER_AUTH_URL);
      mountOneClickUnsubscribe(fastify, app.get(NotificationsService));
      mountFileContent(fastify, auth, app.get(FilesService));
      await mountRpc(fastify, createRouter(createProcedures(auth, memberships), app), {
        logError: (error) => logger.error(error, "unhandled error in procedure"),
        publicUrl: env.BETTER_AUTH_URL,
        release: env.RELEASE,
        exposeDocs: env.NODE_ENV !== "production",
      });
    },
  });
}
