/**
 * Request-scoped structured logging for Nest services (nestjs-pino over @repo/logger).
 *
 * Every HTTP request gets an id (see `requestId`), echoed in the `x-request-id`
 * response header and attached to every log line written while handling it, so one id
 * traces a request through api → queue → worker logs.
 *
 * Inject with `constructor(@InjectPinoLogger(TodoService.name) private log: PinoLogger)`
 * or use Nest's `new Logger(TodoService.name)`; both write through pino.
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { type DynamicModule, RequestMethod } from "@nestjs/common";
import { type LoggerConfig, loggerOptions } from "@repo/logger";
import { LoggerModule as PinoLoggerModule } from "nestjs-pino";
import proxyAddr from "proxy-addr";
import { contextLogFields } from "./context";

export const REQUEST_ID_HEADER = "x-request-id";

/**
 * Builds the per-request id generator. An incoming `x-request-id` is kept only when the
 * direct peer is a trusted proxy (so ids flow gateway → api → other services); from
 * anyone else a caller-chosen id could be used to confuse log searches, so a new
 * UUIDv4 is minted. Fastify calls this once per request and pino-http reuses `req.id`.
 */
export function createRequestIdGenerator(trustedProxies: string[]) {
  const isTrusted = proxyAddr.compile(trustedProxies);
  return (req: IncomingMessage): string => {
    const incoming = req.headers[REQUEST_ID_HEADER];
    const peer = req.socket.remoteAddress;
    const trusted = peer !== undefined && isTrusted(peer, 0);
    return trusted && typeof incoming === "string" && /^[\w.-]{1,128}$/.test(incoming)
      ? incoming
      : randomUUID();
  };
}

export const LoggerModule = {
  forRoot(config: LoggerConfig): DynamicModule {
    return PinoLoggerModule.forRoot({
      // Health probes run every few seconds; logging them is pure noise.
      exclude: [{ method: RequestMethod.ALL, path: "health/*path" }],
      pinoHttp: {
        ...loggerOptions(config),
        // Request, user and org ids on every line written inside a request or job.
        mixin: contextLogFields,
        customLogLevel: (_req, res, error) =>
          error || res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info",
        serializers: {
          req: (req: { id: string; method: string; url: string }) => ({
            id: req.id,
            method: req.method,
            url: req.url,
          }),
          res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
        },
      },
    });
  },
};

export { InjectPinoLogger, Logger, PinoLogger } from "nestjs-pino";
