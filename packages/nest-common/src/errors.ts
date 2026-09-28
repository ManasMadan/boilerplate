/**
 * The one error type services throw for expected failures (not found, conflict, rate
 * limited, ...). It carries a stable, machine-readable `code` from the error catalog in
 * packages/contracts, never a user-facing sentence: clients translate the code, so a
 * Spanish UI never shows an English server message.
 *
 *   throw new AppError("TODO_NOT_FOUND", { status: 404, params: { id } });
 *
 * The API layer maps it to its protocol (oRPC error, RFC 9457 problem+json, MCP error).
 * Anything that is not an AppError is a bug: it is logged with its stack and the
 * client receives a generic INTERNAL error with the request id.
 */
export interface AppErrorOptions {
  /** HTTP status the error maps to. */
  status?: number;
  /** Values the client needs to render the message, e.g. { retryAfterSeconds: 30 }. */
  params?: Record<string, string | number | boolean>;
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly params: Record<string, string | number | boolean>;

  constructor(code: string, options: AppErrorOptions = {}) {
    super(code, { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    this.status = options.status ?? 400;
    this.params = options.params ?? {};
  }
}

export const isAppError = (error: unknown): error is AppError => error instanceof AppError;
