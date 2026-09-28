/**
 * Turning any failure into something the UI can act on. Server errors carry a stable
 * code from packages/contracts; translate it with `t(errorMessageKey(error))` and never
 * show `error.message`, which is not localized.
 */
import { ORPCError } from "@orpc/client";
import { type ErrorCode, isErrorCode } from "@repo/contracts/errors";

export function errorCode(error: unknown): ErrorCode {
  if (error instanceof ORPCError && isErrorCode(error.code)) return error.code;
  // Network failures, CORS, aborted requests: the API was not reached.
  if (error instanceof TypeError) return "SERVICE_UNAVAILABLE";
  return "INTERNAL";
}

/** The i18n key (packages/i18n `errors.*`) for an error. */
export const errorMessageKey = (error: unknown) => `errors.${errorCode(error)}` as const;

export function errorParams(error: unknown): Record<string, string | number | boolean> {
  if (error instanceof ORPCError) {
    const data = error.data as { params?: Record<string, string | number | boolean> } | undefined;
    return data?.params ?? {};
  }
  return {};
}

/** Request id of a failed call, shown on error screens so support can find the logs. */
export function errorRequestId(error: unknown): string | undefined {
  if (error instanceof ORPCError)
    return (error.data as { requestId?: string } | undefined)?.requestId;
  return undefined;
}

/** Per-field validation problems: `{ title: "too_small" }`. */
export function fieldErrors(error: unknown): Record<string, string> {
  if (!(error instanceof ORPCError) || error.code !== "VALIDATION_FAILED") return {};
  const issues =
    (error.data as { issues?: { path: (string | number)[]; code: string }[] } | undefined)
      ?.issues ?? [];
  return Object.fromEntries(issues.map((issue) => [issue.path.join("."), issue.code]));
}
