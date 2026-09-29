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

import { isContractProcedure } from "@orpc/contract";
import { OpenAPIGenerator } from "@orpc/openapi";
import { OpenAPIHandler } from "@orpc/openapi/fastify";
import { RPCHandler } from "@orpc/server/fastify";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { API_KEY_HEADER, contract, type ProcedureMeta } from "@repo/contracts/api";
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

  // Event streams (realtime) must reach the client as they're written. Any compressing
  // or buffering hop (Next's dev proxy, nginx-style gateways, CDNs) would hold them
  // until the stream ends; these headers tell every one of them not to.
  fastify.addHook("onSend", async (_request, reply, payload) => {
    const type = reply.getHeader("content-type");
    if (typeof type === "string" && type.startsWith("text/event-stream")) {
      reply.header("cache-control", "no-cache, no-transform");
      reply.header("x-accel-buffering", "no");
    }
    return payload;
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
        apiKey: { type: "apiKey", in: "header", name: API_KEY_HEADER },
      },
    },
  });
  markApiKeyOperations(spec, contract);
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

type Spec = Awaited<ReturnType<OpenAPIGenerator["generate"]>>;

/**
 * Every operation takes a signed-in session; those whose contract names an API key scope
 * take a key with that scope too, and say so.
 */
function markApiKeyOperations(spec: Spec, router: unknown) {
  if (isContractProcedure(router)) {
    const { route, meta } = router["~orpc"];
    const operation =
      route.path && route.method
        ? spec.paths?.[route.path]?.[route.method.toLowerCase() as "get"]
        : undefined;
    if (!operation) return;
    const scope = (meta as ProcedureMeta).apiKeyScope;
    operation.security = scope ? [{ session: [] }, { apiKey: [] }] : [{ session: [] }];
    if (scope) {
      const note = `API keys need the \`${scope}\` scope.`;
      operation.description = operation.description ? `${operation.description}\n\n${note}` : note;
    }
    return;
  }
  if (typeof router === "object" && router !== null) {
    for (const child of Object.values(router)) markApiKeyOperations(spec, child);
  }
}
