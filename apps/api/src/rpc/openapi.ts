/**
 * The REST API's OpenAPI 3.1 document, generated from the contract. The server serves it
 * at /api/v1/openapi.json; `bun run gen` also writes it to apps/api/openapi.json, so a
 * pull request shows every change to the public API as a diff and CI can refuse the
 * breaking ones (oasdiff, in ci.yml).
 */
import { isContractProcedure } from "@orpc/contract";
import { OpenAPIGenerator } from "@orpc/openapi";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { API_KEY_HEADER, contract, type ProcedureMeta } from "@repo/contracts/api";

export async function openApiDocument({
  version,
  serverUrl,
}: {
  version: string;
  serverUrl: string;
}) {
  const spec = await new OpenAPIGenerator({
    schemaConverters: [new ZodToJsonSchemaConverter()],
  }).generate(contract, {
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
  return spec;
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
