/**
 * Serves better-auth under /api/auth/* on the Fastify instance.
 *
 * Fastify has already parsed the JSON body by the time the route runs, so the request
 * is rebuilt as a Web Request for better-auth. Set-Cookie headers are copied one by one:
 * joining them with commas (what a plain header copy does) corrupts cookie attributes.
 */
import type { FastifyInstance } from "fastify";
import type { Auth } from "./auth";

export function mountAuth(fastify: FastifyInstance, auth: Auth, baseUrl: string) {
  fastify.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    async handler(request, reply) {
      const url = new URL(request.url, baseUrl);
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) {
        if (value !== undefined)
          headers.set(key, Array.isArray(value) ? value.join(", ") : String(value));
      }
      const body =
        request.method === "GET" || request.body === undefined
          ? undefined
          : JSON.stringify(request.body);
      const response = await auth.handler(
        new Request(url, { method: request.method, headers, ...(body !== undefined && { body }) }),
      );

      reply.status(response.status);
      for (const [key, value] of response.headers) {
        if (key.toLowerCase() !== "set-cookie") reply.header(key, value);
      }
      const cookies = response.headers.getSetCookie();
      if (cookies.length) reply.header("set-cookie", cookies);
      return reply.send(response.body ? Buffer.from(await response.arrayBuffer()) : null);
    },
  });
}
