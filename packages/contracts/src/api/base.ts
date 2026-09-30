/**
 * The base every procedure is built from. It declares the error codes any call can fail
 * with (COMMON_ERRORS: authentication, validation, limits, the server refusing the
 * request); each contract module adds the codes its own procedures throw with
 * `.errors(errorsOf(...))`. So a client gets the union of codes a call can fail with
 * (`isDefinedError(error) && error.code === "TODO_NOT_FOUND"`), the OpenAPI document
 * lists only those per operation, and every surface returns the same structure. The API
 * refuses, outside production, to answer a code a procedure didn't declare.
 * Procedures may also say which API key scope lets a key call them (see ./scopes.ts).
 */
import { oc } from "@orpc/contract";
import * as z from "zod";
import { ERROR_CODES, type ErrorCode, errorCode } from "../errors";
import type { ProcedureMeta } from "./scopes";

/** One field's problem in a VALIDATION_FAILED error: where, and a code the client translates. */
export const errorIssue = z.object({
  path: z.array(z.union([z.string(), z.number()])),
  code: z.string(),
});

export const errorData = z.object({
  /**
   * Values the client needs to render the translated message. Strings and numbers only:
   * they're ICU message arguments (use `{flag, select, yes {…} other {…}}` for choices).
   */
  params: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
  /** Correlates the error with server logs; show it on error screens. */
  requestId: z.string().optional(),
  /** Per-field problems for VALIDATION_FAILED: path + code, translated client-side. */
  issues: z.array(errorIssue).optional(),
});
export type ErrorData = z.infer<typeof errorData>;

/**
 * The body of every error response, as oRPC serializes a contract error
 * (`ORPCError.toJSON()`). The Python service answers with exactly this shape too: its
 * model is generated from this schema.
 */
export const errorResponse = z.object({
  defined: z.boolean(),
  code: errorCode,
  status: z.number().int(),
  /** For logs only: clients translate `code`. */
  message: z.string(),
  data: errorData,
});
export type ErrorResponse = z.infer<typeof errorResponse>;

/** The oRPC error map for these codes, with their catalog statuses and the one data shape. */
export function errorsOf<C extends ErrorCode>(...codes: C[]) {
  return Object.fromEntries(
    codes.map((code) => [code, { status: ERROR_CODES[code], data: errorData }]),
  ) as { [K in C]: { status: (typeof ERROR_CODES)[K]; data: typeof errorData } };
}

/** What any call can fail with, whatever it does. */
export const COMMON_ERRORS = [
  "BAD_REQUEST",
  "VALIDATION_FAILED",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "RATE_LIMITED",
  "INTERNAL",
  "SERVICE_UNAVAILABLE",
  "CLIENT_OUTDATED",
  "PAYLOAD_TOO_LARGE",
  "UNSUPPORTED_MEDIA_TYPE",
  "METHOD_NOT_SUPPORTED",
  "TIMEOUT",
] as const satisfies readonly ErrorCode[];

/** What a call in a workspace adds: none active, or an API key without the scope. */
export const WORKSPACE_ERRORS = [
  "NO_ACTIVE_ORGANIZATION",
  "API_KEY_SCOPE_MISSING",
] as const satisfies readonly ErrorCode[];

export const base = oc.$meta<ProcedureMeta>({}).errors(errorsOf(...COMMON_ERRORS));
