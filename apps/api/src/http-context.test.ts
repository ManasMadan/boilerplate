import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import { contextFor, toHeaders } from "./http-context";

const request = (headers: FastifyRequest["headers"]) =>
  ({ id: "req-1", headers }) as FastifyRequest;

describe("a request's context", () => {
  it("takes the language from x-locale first, then Accept-Language", () => {
    expect(contextFor(request({ "x-locale": "es", "accept-language": "en" }))).toEqual({
      requestId: "req-1",
      locale: "es",
      clientVersion: undefined,
    });
    expect(contextFor(request({ "accept-language": "es-MX", "x-app-version": "2.0.0" }))).toEqual({
      requestId: "req-1",
      locale: "es",
      clientVersion: "2.0.0",
    });
  });
});

describe("a request's headers", () => {
  it("become Web headers, a repeated one joined and a missing one left out", () => {
    const headers = toHeaders(
      request({ host: "api.test", "set-cookie": ["a=1", "b=2"], "x-empty": undefined }),
    );
    expect([...headers]).toEqual([
      ["host", "api.test"],
      ["set-cookie", "a=1, b=2"],
    ]);
  });
});
