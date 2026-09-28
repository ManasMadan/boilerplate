/**
 * The one error type services throw for expected failures (not found, conflict, rate
 * limited, ...). It carries a stable, machine-readable code from the catalog in
 * packages/contracts/src/errors.ts, never a user-facing sentence: clients translate the
 * code, so a Spanish UI never shows an English server message. The HTTP status comes
 * from the catalog, so it is defined once per code.
 *
 *   throw new AppError("TODO_NOT_FOUND", { params: { id } });
 *
 * The API layer maps it to its protocol (oRPC error, RFC 9457 problem+json, MCP error).
 * Anything that is not an AppError is a bug: it is logged with its stack and the
 * client receives a generic INTERNAL error with the request id.
 */
import { ERROR_CODES, type ErrorCode } from "@repo/contracts/errors";

export type { ErrorCode };

export interface AppErrorOptions {
  /** Values the client needs to render the message, e.g. { retryAfterSeconds: 30 }. */
  params?: Record<string, string | number>;
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly params: Record<string, string | number>;

  constructor(code: ErrorCode, options: AppErrorOptions = {}) {
    super(code, { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    this.status = ERROR_CODES[code];
    this.params = options.params ?? {};
  }
}

export const isAppError = (error: unknown): error is AppError => error instanceof AppError;
