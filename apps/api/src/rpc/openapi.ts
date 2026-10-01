/**
 * The REST API's OpenAPI 3.1 document, generated from the contract. The server serves it
 * at /api/v1/openapi.json; `bun run gen` also writes it to apps/api/openapi.json, so a
 * pull request shows every change to the public API as a diff and CI can refuse the
 * breaking ones (oasdiff, in ci.yml).
 */
import { type AnyContractProcedure, isContractProcedure } from "@orpc/contract";
import { type OpenAPI, OpenAPIGenerator, toOpenAPISchema } from "@orpc/openapi";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { API_KEY_HEADER, contract, errorData, type ProcedureMeta } from "@repo/contracts/api";
import { events, webhookEvents } from "@repo/contracts/events";
import * as z from "zod";

export async function openApiDocument({
  version,
  serverUrl,
}: {
  version: string;
  serverUrl: string;
}) {
  const converter = new ZodToJsonSchemaConverter();
  const spec = await new OpenAPIGenerator({ schemaConverters: [converter] }).generate(contract, {
    // One definition every error response refers to, not a copy per status per operation.
    commonSchemas: { ErrorData: { schema: errorData } },
    info: { title: "Boilerplate API", version },
    servers: [{ url: serverUrl }],
    components: {
      securitySchemes: {
        session: { type: "apiKey", in: "cookie", name: "better-auth.session_token" },
        apiKey: { type: "apiKey", in: "header", name: API_KEY_HEADER },
      },
    },
  });
  markApiKeyOperations(spec, contract);
  addWebhooks(spec, converter);
  return spec;
}

/**
 * What an endpoint receives for each event customers can subscribe to, in the Standard
 * Webhooks shape the delivery service signs (apps/webhooks). Each body is a component,
 * so client generators give it a name.
 */
function addWebhooks(spec: Spec, converter: ZodToJsonSchemaConverter) {
  const schemas: Record<string, OpenAPI.SchemaObject> = {};
  const webhooks: Record<string, OpenAPI.PathItemObject> = {};
  for (const name of webhookEvents) {
    const body = z.object({
      type: z.literal(name),
      timestamp: z.iso.datetime({ offset: true }),
      data: events[name],
    });
    const component = `webhook.${name}`;
    schemas[component] = toOpenAPISchema(converter.convert(body, { strategy: "output" })[1]);
    webhooks[name] = {
      post: {
        operationId: component,
        summary: name,
        description:
          "Signed with the endpoint's secret: verify the webhook-id, webhook-timestamp and webhook-signature headers (Standard Webhooks) before trusting it.",
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: { $ref: `#/components/schemas/${component}` } },
          },
        },
        responses: { "2XX": { description: "Received. Anything else is retried." } },
      },
    };
  }
  spec.components = { ...spec.components, schemas: { ...spec.components?.schemas, ...schemas } };
  spec.webhooks = webhooks;
}

type Spec = Awaited<ReturnType<OpenAPIGenerator["generate"]>>;

/** A procedure's meta: the contract types it `any` once it's any procedure. */
const metaOf = (procedure: { "~orpc": { meta: unknown } }) =>
  procedure["~orpc"].meta as ProcedureMeta;

/**
 * Every operation takes a signed-in session; those whose contract names an API key scope
 * take a key with that scope too, and say so.
 */
export function markApiKeyOperations(spec: Spec, router: unknown) {
  if (isContractProcedure(router)) return markOperation(spec, router);
  if (typeof router === "object" && router !== null) {
    const children: unknown[] = Object.values(router);
    for (const child of children) markApiKeyOperations(spec, child);
  }
}

/** One procedure's operation: its security, and its scope in the description. */
function markOperation(spec: Spec, procedure: AnyContractProcedure) {
  const { route } = procedure["~orpc"];
  const operation =
    route.path && route.method
      ? spec.paths?.[route.path]?.[route.method.toLowerCase() as "get"]
      : undefined;
  if (!operation) return;
  const scope = metaOf(procedure).apiKeyScope;
  operation.security = scope ? [{ session: [] }, { apiKey: [] }] : [{ session: [] }];
  if (scope) {
    const note = `API keys need the \`${scope}\` scope.`;
    operation.description = operation.description ? `${operation.description}\n\n${note}` : note;
  }
}
