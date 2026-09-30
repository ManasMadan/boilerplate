/**
 * Turning any failure into something the UI can act on. Server errors carry a stable
 * code from packages/contracts; translate it with `t(errorMessageKey(error))` and never
 * show `error.message`, which is not localized.
 */
import { ORPCError } from "@orpc/client";
import { errorData } from "@repo/contracts/api/base";
import { type ErrorCode, isErrorCode } from "@repo/contracts/errors";

/** `instanceof ORPCError`, typed: the bare check narrows to ORPCError<any, any>. */
const isOrpcError = (error: unknown): error is ORPCError<string, unknown> =>
  error instanceof ORPCError;

export function errorCode(error: unknown): ErrorCode {
  if (isOrpcError(error) && isErrorCode(error.code)) return error.code;
  // Network failures, CORS, aborted requests: the API was not reached.
  if (error instanceof TypeError) return "SERVICE_UNAVAILABLE";
  return "INTERNAL";
}

/** The i18n key (packages/i18n `errors.*`) for an error. */
export const errorMessageKey = (error: unknown) => `errors.${errorCode(error)}` as const;

/** An error's data as the contract defines it, or nothing when it has none (or not that). */
function dataOf(error: unknown) {
  if (!isOrpcError(error)) return undefined;
  const parsed = errorData.safeParse(error.data);
  return parsed.success ? parsed.data : undefined;
}

export function errorParams(error: unknown): Record<string, string | number> {
  return dataOf(error)?.params ?? {};
}

/** Request id of a failed call, shown on error screens so support can find the logs. */
export function errorRequestId(error: unknown): string | undefined {
  return dataOf(error)?.requestId;
}

/** Per-field validation problems: `{ title: "too_small" }`. */
export function fieldErrors(error: unknown): Record<string, string> {
  if (!isOrpcError(error) || error.code !== "VALIDATION_FAILED") return {};
  const issues = dataOf(error)?.issues ?? [];
  return Object.fromEntries(issues.map((issue) => [issue.path.join("."), issue.code]));
}
