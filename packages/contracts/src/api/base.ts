/**
 * The base every procedure is built from. It declares every catalog error code as a
 * typed oRPC error with one data shape, so clients get the exact union of codes a call
 * can fail with (`isDefinedError(error) && error.code === "TODO_NOT_FOUND"`) and every
 * surface returns the same structure.
 */
import { oc } from "@orpc/contract";
import { z } from "zod";
import { ERROR_CODES, type ErrorCode } from "../errors";

export const errorData = z.object({
  /** Values the client needs to render the translated message. */
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  /** Correlates the error with server logs; show it on error screens. */
  requestId: z.string().optional(),
  /** Per-field problems for VALIDATION_FAILED: path + code, translated client-side. */
  issues: z
    .array(z.object({ path: z.array(z.union([z.string(), z.number()])), code: z.string() }))
    .optional(),
});
export type ErrorData = z.infer<typeof errorData>;

const errorMap = Object.fromEntries(
  (Object.entries(ERROR_CODES) as [ErrorCode, number][]).map(([code, status]) => [
    code,
    { status, data: errorData },
  ]),
) as { [C in ErrorCode]: { status: (typeof ERROR_CODES)[C]; data: typeof errorData } };

export const base = oc.errors(errorMap);
