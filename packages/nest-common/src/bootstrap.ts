/**
 * Starts a Nest service on Fastify with production defaults. Every service's
 * `main.ts` is a single call to this, so the behaviour below is identical everywhere.
 */
import "reflect-metadata";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import underPressure from "@fastify/under-pressure";
import type { INestApplication, Type } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Logger } from "nestjs-pino";
import { createRequestIdGenerator, REQUEST_ID_HEADER } from "./logging";

export interface BootstrapOptions {
  port: number;
  /** Peers allowed to set X-Forwarded-For / x-request-id (see `coreEnv.TRUSTED_PROXIES`). */
  trustedProxies: string[];
  /** Browser origins allowed to call this service with credentials. Omit for internal services. */
  corsOrigins?: string[];
  /** Runs after plugins are registered and before `listen`, e.g. to mount non-Nest routes. */
  configure?: (app: NestFastifyApplication) => Promise<void> | void;
}

export async function bootstrap(
  module: Type,
  options: BootstrapOptions,
): Promise<INestApplication> {
  const adapter = new FastifyAdapter({
    // Behind a load balancer the client IP arrives in X-Forwarded-For. Only trusted
    // proxies may set it, otherwise any caller could forge the IP that rate limiting,
    // lockout and audit logs rely on.
    trustProxy: options.trustedProxies,
    // Uploads go straight to object storage via presigned URLs; request bodies stay small.
    bodyLimit: 1024 * 1024,
    // Our pino logger (nestjs-pino) logs requests; Fastify's own logger would duplicate it.
    logger: false,
    // One id per request, reused by the logger (see createRequestIdGenerator).
    requestIdHeader: false,
    genReqId: createRequestIdGenerator(options.trustedProxies),
  });

  const app = await NestFactory.create<NestFastifyApplication>(module, adapter, {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));

  await app.register(helmet, {
    // JSON API: no HTML is served, so a locked-down CSP costs nothing.
    contentSecurityPolicy: {
      useDefaults: false,
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    },
    crossOriginResourcePolicy: { policy: "same-site" },
  });
  // Shed load instead of queueing it: when the event loop or heap is saturated, answer
  // 503 immediately (the load balancer retries elsewhere) rather than letting every
  // request time out. Readiness fails too, so Kubernetes stops routing here.
  await app.register(underPressure, {
    maxEventLoopDelay: 1_000,
    maxHeapUsedBytes: 0.9 * (process.constrainedMemory?.() || 1024 * 1024 * 1024 * 2),
    retryAfter: 5,
    exposeStatusRoute: false,
  });

  if (options.corsOrigins?.length) {
    await app.register(cors, {
      origin: options.corsOrigins,
      credentials: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      // Lets the browser read the request id (for error screens and support tickets).
      exposedHeaders: [REQUEST_ID_HEADER],
      maxAge: 600,
    });
  }

  // Echo the id so clients and upstream proxies can correlate their logs with ours.
  app
    .getHttpAdapter()
    .getInstance()
    .addHook("onRequest", async (request, reply) => {
      reply.header(REQUEST_ID_HEADER, request.id);
    });

  // SIGTERM (Kubernetes) → stop accepting connections, finish in-flight requests, run
  // every provider's onApplicationShutdown (close DB/Redis/queues), then exit.
  app.enableShutdownHooks();

  await options.configure?.(app);
  await app.listen({ port: options.port, host: "0.0.0.0" });
  return app;
}
