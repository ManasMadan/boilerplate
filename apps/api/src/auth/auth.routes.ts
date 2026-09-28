/**
 * Serves better-auth under /api/auth/* on the Fastify instance.
 *
 * Fastify has already parsed the JSON body by the time the route runs, so the request
 * is rebuilt as a Web Request for better-auth, carrying the verified client IP. Set-Cookie headers are copied one by one:
 * joining them with commas (what a plain header copy does) corrupts cookie attributes.
 */

import { runWithContext, updateContext } from "@repo/nest-common";
import type { FastifyInstance } from "fastify";
import { contextFor, toHeaders } from "../http-context";
import type { Auth } from "./auth";

export function mountAuth(fastify: FastifyInstance, auth: Auth, baseUrl: string) {
  fastify.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    handler: (request, reply) =>
      // Same request context as the rest of the API: logs, queued emails and audit
      // events from auth flows carry the request id and the acting user.
      runWithContext(contextFor(request), async () => {
        const url = new URL(request.url, baseUrl);
        const headers = toHeaders(request);
        // better-auth rate-limits and records sessions by the first X-Forwarded-For entry,
        // which any client can write. Replace it with the address Fastify resolved through
        // TRUSTED_PROXIES, so only a trusted gateway can vouch for the client IP.
        headers.set("x-forwarded-for", request.ip);
        if (request.headers.cookie?.includes("session_token")) {
          const session = await auth.api.getSession({ headers });
          if (session) updateContext({ userId: session.user.id });
        }
        const body =
          request.method === "GET" || request.body === undefined
            ? undefined
            : JSON.stringify(request.body);
        const response = await auth.handler(
          new Request(url, {
            method: request.method,
            headers,
            ...(body !== undefined && { body }),
          }),
        );

        reply.status(response.status);
        for (const [key, value] of response.headers) {
          if (key.toLowerCase() !== "set-cookie") reply.header(key, value);
        }
        const cookies = response.headers.getSetCookie();
        if (cookies.length) reply.header("set-cookie", cookies);
        return reply.send(response.body ? Buffer.from(await response.arrayBuffer()) : null);
      }),
  });
}
