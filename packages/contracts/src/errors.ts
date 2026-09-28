/**
 * Every error code the API can return. Clients translate codes with the `errors.<CODE>`
 * keys in packages/i18n, so messages are always in the user's language, and branch on
 * codes (never on message text).
 *
 * The wire shape is the same on every surface (oRPC, REST problem+json, MCP):
 *   { code: "TODO_NOT_FOUND", status: 404, requestId: "…", params: { … } }
 *
 * Adding a code: add it here with its HTTP status, then add `errors.<CODE>` to every
 * catalog in packages/i18n (the i18n test fails until you do).
 */
export const ERROR_CODES = {
  // Generic
  BAD_REQUEST: 400,
  VALIDATION_FAILED: 422,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  SERVICE_UNAVAILABLE: 503,
  // Platform
  IDEMPOTENCY_IN_PROGRESS: 409,
  FEATURE_DISABLED: 404,
  CLIENT_OUTDATED: 426,
  FRESH_SESSION_REQUIRED: 403,
  DESTINATION_NOT_ALLOWED: 400,
  RESPONSE_TOO_LARGE: 502,
  TOO_MANY_REDIRECTS: 502,
  UPSTREAM_UNAVAILABLE: 502,
  // Tenancy
  NO_ACTIVE_ORGANIZATION: 403,
  // Todos (example feature)
  TODO_NOT_FOUND: 404,
  TODO_VERSION_CONFLICT: 409,
} as const satisfies Record<string, number>;

export type ErrorCode = keyof typeof ERROR_CODES;

export const isErrorCode = (value: unknown): value is ErrorCode =>
  typeof value === "string" && Object.hasOwn(ERROR_CODES, value);
