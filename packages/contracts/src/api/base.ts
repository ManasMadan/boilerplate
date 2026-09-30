/**
 * The base every procedure is built from. It declares every catalog error code as a
 * typed oRPC error with one data shape, so clients get the exact union of codes a call
 * can fail with (`isDefinedError(error) && error.code === "TODO_NOT_FOUND"`) and every
 * surface returns the same structure. Procedures may also say which API key scope lets
 * a key call them (see ./scopes.ts).
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

const errorMap = Object.fromEntries(
  (Object.entries(ERROR_CODES) as [ErrorCode, number][]).map(([code, status]) => [
    code,
    { status, data: errorData },
  ]),
) as { [C in ErrorCode]: { status: (typeof ERROR_CODES)[C]; data: typeof errorData } };

export const base = oc.$meta<ProcedureMeta>({}).errors(errorMap);
