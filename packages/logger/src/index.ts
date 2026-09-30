/**
 * The one logger configuration for every TypeScript service.
 *
 * - Production: one JSON object per line on stdout, which every log platform (Loki,
 *   CloudWatch, Datadog, GCP Logging) ingests without parsing rules.
 * - Development: human-readable, colorized output via pino-pretty.
 * - Always: `service` on every line, ISO timestamps, `level` as a string, and secrets
 *   redacted before they leave the process.
 *
 * Python services emit the same shape via structlog (apps/ai/app/logging.py), so one
 * query works across languages: `{service="api", level="error"}`.
 */
import { type LoggerOptions, pino } from "pino";

export type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";

export interface LoggerConfig {
  service: string;
  level?: LogLevel;
  pretty?: boolean;
}

/** Header paths removed from request/response logs. */
export const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
];

/**
 * Field names censored wherever they appear, at any depth (a job payload nests the
 * code as `job.data.data.otp`, which path-based redaction would miss). Compared
 * case-insensitively. Add any field that can carry a credential or one-time secret.
 */
export const SENSITIVE_KEYS = new Set([
  "password",
  "newpassword",
  "currentpassword",
  "otp",
  "token",
  "secret",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "apikey",
  "authorization",
  "cookie",
  "backupcodes",
]);

const CENSOR = "[redacted]";
const MAX_DEPTH = 8;

/** Returns a copy of `value` with every sensitive field censored. Exported for tests. */
export function scrub(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => scrub(item, depth + 1));
  if (value instanceof Error) return value;
  const out: Record<string, unknown> = {};
  const fields: [string, unknown][] = Object.entries(value);
  for (const [key, inner] of fields) {
    out[key] = SENSITIVE_KEYS.has(key.toLowerCase()) ? CENSOR : scrub(inner, depth + 1);
  }
  return out;
}

export function loggerOptions({
  service,
  level = "info",
  pretty = false,
}: LoggerConfig): LoggerOptions {
  return {
    level,
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
      log: (object) => scrub(object) as Record<string, unknown>,
    },
    redact: { paths: REDACT_PATHS, censor: CENSOR },
    ...(pretty && {
      transport: {
        target: "pino-pretty",
        options: {
          colorize: true,
          singleLine: true,
          translateTime: "HH:MM:ss.l",
          ignore: "pid,hostname,service",
        },
      },
    }),
  };
}

export function createLogger(config: LoggerConfig) {
  return pino(loggerOptions(config));
}

export type Logger = ReturnType<typeof createLogger>;
