/**
 * What every HTTP entry point (oRPC, REST, better-auth) knows about a request before any
 * handler runs: its id, the client's language and app version. Handlers run inside
 * `runWithContext(contextFor(request), ...)`; the user and organization are added once
 * the session is resolved.
 */
import { type Locale, negotiateLocale } from "@repo/i18n";
import type { RequestContext } from "@repo/nest-common";
import type { FastifyRequest } from "fastify";

export function contextFor(request: FastifyRequest): RequestContext & { locale: Locale } {
  const header = (name: string) => {
    const value = request.headers[name];
    return typeof value === "string" ? value : undefined;
  };
  return {
    requestId: request.id,
    locale: negotiateLocale(header("x-locale") ?? header("accept-language")),
    clientVersion: header("x-app-version"),
  };
}

/** Fastify's parsed headers as a Web Headers object (for better-auth and oRPC). */
export function toHeaders(request: FastifyRequest) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value !== undefined)
      headers.set(key, Array.isArray(value) ? value.join(", ") : String(value));
  }
  return headers;
}
