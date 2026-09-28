/**
 * Typed HTTP client for the Python AI service (apps/ai).
 *
 * The types in `schema.gen.ts` are generated from the service's OpenAPI document,
 * which FastAPI derives from its Pydantic models. The chain is:
 *
 *   apps/ai/app/schemas.py  ──(bun run gen)──▶  apps/ai/openapi.json
 *                           ──(bun run gen)──▶  packages/ai-client/src/schema.gen.ts
 *
 * so `client.POST("/v1/sentiment", { body })` is checked against the Python model:
 * wrong paths, missing fields and wrong response shapes are compile errors.
 * Never edit schema.gen.ts by hand; CI fails if it is out of date.
 */
import createClient from "openapi-fetch";
import type { components, paths } from "./schema.gen";

export function createAiClient(baseUrl: string, options: { timeoutMs?: number } = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  return createClient<paths>({
    baseUrl,
    // A hung model server must not hang the API request that called it.
    fetch: (request) => fetch(request, { signal: AbortSignal.timeout(timeoutMs) }),
  });
}

export type AiClient = ReturnType<typeof createAiClient>;
export type AiSchemas = components["schemas"];
