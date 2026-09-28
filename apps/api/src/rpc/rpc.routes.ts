/**
 * Serves the API on the Fastify instance, from one router:
 *
 *   /rpc/*                 oRPC protocol, used by web and mobile (keeps Dates and other
 *                          rich types, streams subscriptions)
 *   /api/v1/*              REST, for third parties and API keys; same procedures
 *   /api/v1/openapi.json   OpenAPI 3.1 document generated from the contract
 *   /docs                  interactive API reference (not in production)
 *
 * Every request runs inside a request context (request id, locale, client version) so
 * logs, queued jobs and outbox events all carry the same request id.
 */

import { OpenAPIGenerator } from "@orpc/openapi";
import { OpenAPIHandler } from "@orpc/openapi/fastify";
import { RPCHandler } from "@orpc/server/fastify";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { contract } from "@repo/contracts/api";
import { runWithContext } from "@repo/nest-common";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { contextFor, toHeaders } from "../http-context";
import { toContractError } from "./procedures";
import type { AppRouter } from "./router";

export interface MountOptions {
  logError: (error: unknown) => void;
  publicUrl: string;
  release: string;
  exposeDocs: boolean;
}

export async function mountRpc(fastify: FastifyInstance, router: AppRouter, options: MountOptions) {
  // Converts every error to the contract's shape, for both protocols.
  const mapErrors = async ({ next }: { next: () => Promise<unknown> }) => {
    try {
      return await next();
    } catch (error) {
      throw toContractError(error, options.logError);
    }
  };

  const rpc = new RPCHandler(router, {
    clientInterceptors: [mapErrors],
    // Keeps idle event streams alive through proxies (Cloudflare closes idle ones at 100s).
    eventIteratorKeepAliveInterval: 20_000,
  });
  const rest = new OpenAPIHandler(router, {
    clientInterceptors: [mapErrors],
    eventIteratorKeepAliveInterval: 20_000,
  });

  // oRPC parses non-JSON bodies (multipart uploads) itself; Nest's adapter keeps JSON.
  fastify.addContentTypeParser("*", (_request, _payload, done) => done(null, undefined));

  const serve = (handler: RPCHandler<object> | OpenAPIHandler<object>, prefix: `/${string}`) =>
    async function handle(
      request: FastifyRequest,
      reply: Parameters<RPCHandler<object>["handle"]>[1],
    ) {
      await runWithContext(contextFor(request), async () => {
        const { matched } = await handler.handle(request, reply, {
          prefix,
          context: { headers: toHeaders(request) },
        });
        if (!matched) await reply.status(404).send({ code: "NOT_FOUND", requestId: request.id });
      });
    };

  fastify.all("/rpc/*", serve(rpc, "/rpc"));
  fastify.all("/api/v1/*", serve(rest, "/api/v1"));

  const spec = await new OpenAPIGenerator({
    schemaConverters: [new ZodToJsonSchemaConverter()],
  }).generate(contract, {
    info: { title: "Boilerplate API", version: options.release },
    servers: [{ url: new URL("/api/v1", options.publicUrl).toString() }],
    components: {
      securitySchemes: {
        session: { type: "apiKey", in: "cookie", name: "better-auth.session_token" },
        apiKey: { type: "apiKey", in: "header", name: "x-api-key" },
      },
    },
    security: [{ session: [] }, { apiKey: [] }],
  });
  fastify.get("/api/v1/openapi.json", async () => spec);

  if (options.exposeDocs) {
    fastify.get("/docs", async (_request, reply) =>
      reply
        .type("text/html")
        .send(`<!doctype html><html><head><title>API reference</title><meta charset="utf-8"/></head>
<body><script id="api-reference" data-url="/api/v1/openapi.json"></script>
<script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.72.1"></script></body></html>`),
    );
  }
}
