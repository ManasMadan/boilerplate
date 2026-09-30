import * as z from "zod";

/**
 * Every error code the API can return. Clients translate codes with the `errors.<CODE>`
 * keys in packages/i18n, so messages are always in the user's language, and branch on
 * codes (never on message text).
 *
 * The wire shape is oRPC's error JSON, the same over /rpc and REST (/api/v1), with the
 * HTTP status from this catalog:
 *   { code: "TODO_NOT_FOUND", status: 404, message: "…", data: { requestId: "…", params: { … } } }
 * `message` is for logs only; clients translate `code`.
 *
 * Adding a code: add it here with its HTTP status, then add `errors.<CODE>` to every
 * catalog in packages/i18n (the i18n test fails until you do). `bun run gen` exports
 * the catalog to the Python service (packages/jobs/scripts/export-schemas.ts), which
 * derives its statuses from it too.
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
  // HTTP (answered before a procedure runs: the server, or oRPC, refused the request)
  METHOD_NOT_SUPPORTED: 405,
  TIMEOUT: 408,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
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
  // Account
  PHONE_CODE_INVALID: 400,
  PHONE_NUMBER_TAKEN: 409,
  // Billing
  ENTITLEMENT_REQUIRED: 402,
  ALREADY_SUBSCRIBED: 409,
  NO_SUBSCRIPTION: 409,
  // Files
  FILE_NOT_FOUND: 404,
  FILE_TYPE_NOT_ALLOWED: 422,
  FILE_TOO_LARGE: 413,
  /** The upload isn't the size the client declared when it asked to upload. */
  FILE_SIZE_MISMATCH: 422,
  FILE_INFECTED: 422,
  FILE_UNREADABLE: 422,
  FILE_NOT_UPLOADED: 409,
  FILE_NOT_READY: 409,
  // Notifications
  UNSUBSCRIBE_LINK_INVALID: 400,
  // Inbound webhooks (Stripe, the mail server): the signature doesn't match the body
  INVALID_SIGNATURE: 400,
  // Webhooks
  WEBHOOK_ENDPOINT_NOT_FOUND: 404,
  WEBHOOK_DELIVERY_NOT_FOUND: 404,
  WEBHOOK_URL_NOT_ALLOWED: 422,
  WEBHOOK_ENDPOINT_LIMIT: 409,
  // Connected apps (OAuth / MCP clients)
  APP_NOT_FOUND: 404,
  // API keys
  API_KEY_NOT_FOUND: 404,
  API_KEY_LIMIT_REACHED: 409,
  /** The key is valid but lacks the scope this call needs (params: scope). */
  API_KEY_SCOPE_MISSING: 403,
  // AI
  DOCUMENT_NOT_FOUND: 404,
  DOCUMENT_INDEXING_FAILED: 422,
  AI_BUDGET_EXCEEDED: 429,
  AI_RUN_LIMIT: 422,
  // Todos (example feature)
  TODO_NOT_FOUND: 404,
  TODO_VERSION_CONFLICT: 409,
} as const satisfies Record<string, number>;

export type ErrorCode = keyof typeof ERROR_CODES;

export const errorCode = z.enum(Object.keys(ERROR_CODES) as ErrorCode[]);

export const isErrorCode = (value: unknown): value is ErrorCode =>
  typeof value === "string" && Object.hasOwn(ERROR_CODES, value);
