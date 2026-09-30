/**
 * Turning any failure into something the UI can act on. Server errors carry a stable
 * code from packages/contracts; translate it with `t(errorMessageKey(error))` and never
 * show `error.message`, which is not localized.
 */
import { ORPCError } from "@orpc/client";
import { errorData } from "@repo/contracts/api/base";
import { type ErrorCode, isErrorCode } from "@repo/contracts/errors";

export function errorCode(error: unknown): ErrorCode {
  if (error instanceof ORPCError && isErrorCode(error.code)) return error.code;
  // Network failures, CORS, aborted requests: the API was not reached.
  if (error instanceof TypeError) return "SERVICE_UNAVAILABLE";
  return "INTERNAL";
}

/** The i18n key (packages/i18n `errors.*`) for an error. */
export const errorMessageKey = (error: unknown) => `errors.${errorCode(error)}` as const;

/** An error's data as the contract defines it, or nothing when it has none (or not that). */
function dataOf(error: unknown) {
  if (!(error instanceof ORPCError)) return undefined;
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
  if (!(error instanceof ORPCError) || error.code !== "VALIDATION_FAILED") return {};
  const issues = dataOf(error)?.issues ?? [];
  return Object.fromEntries(issues.map((issue) => [issue.path.join("."), issue.code]));
}
