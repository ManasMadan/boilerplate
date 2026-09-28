/**
 * Environment fragments shared by every Nest service.
 *
 * Each service composes its own schema from these plus its specific variables:
 *
 *   export const env = createEnv({
 *     server: { ...coreEnv, ...databaseEnv, ...redisEnv, PORT: port(3001), MY_VAR: z.string() },
 *     runtimeEnv: process.env,
 *     emptyStringAsUndefined: true,
 *   });
 *
 * so a shared variable has one name, one validation rule and one default everywhere.
 */
import { z } from "zod";

export const nodeEnv = z.enum(["development", "test", "production"]).default("development");
export const logLevel = z
  .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
  .default("info");

export const port = (fallback: number) =>
  z.coerce.number().int().min(1).max(65_535).default(fallback);

export const coreEnv = {
  NODE_ENV: nodeEnv,
  LOG_LEVEL: logLevel,
  /**
   * Which peers may set X-Forwarded-For / x-request-id. Comma-separated CIDRs or the
   * proxy-addr names `loopback`, `linklocal`, `uniquelocal`. The client IP drives rate
   * limits, lockout and audit logs, so trusting everyone would let any caller forge it.
   * Kubernetes: the gateway's pod range (the private `uniquelocal` ranges cover it).
   */
  TRUSTED_PROXIES: z
    .string()
    .default("loopback")
    .transform((value) =>
      value
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean),
    ),
  /** Git SHA of the running build, stamped by CI into the image. */
  RELEASE: z.string().default("dev"),
};

const postgresUrl = z.url({ protocol: /^postgres(ql)?$/ });

/**
 * Database variables for one service. Every service connects as its own Postgres role
 * (least privilege, enforced by GRANTs and row-level security), so each has its own
 * URL: `databaseEnv("API")` gives `API_DATABASE_URL` and `API_DATABASE_POOL_MAX`.
 * Locally they all live in the root .env; in Kubernetes each service's secret holds
 * only its own.
 */
export function databaseEnv<const S extends string>(service: S) {
  return {
    /** Pooled connection (PgBouncer in Kubernetes) used for all queries. */
    [`${service}_DATABASE_URL`]: postgresUrl,
    /** Connections this process may hold; the sum across replicas must stay under the server limit. */
    [`${service}_DATABASE_POOL_MAX`]: z.coerce.number().int().positive().default(10),
  } as { [K in `${S}_DATABASE_URL`]: typeof postgresUrl } & {
    [K in `${S}_DATABASE_POOL_MAX`]: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
  };
}

/**
 * A direct (non-pooled) connection for LISTEN/NOTIFY, which a transaction-mode pooler
 * silently drops. Only the worker's outbox relay needs it.
 */
export function directDatabaseEnv<const S extends string>(service: S) {
  return { [`${service}_DATABASE_DIRECT_URL`]: postgresUrl } as {
    [K in `${S}_DATABASE_DIRECT_URL`]: typeof postgresUrl;
  };
}

export const redisEnv = {
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
};

/**
 * Makes a variable mandatory in production while allowing a local default elsewhere,
 * so a forgotten production setting fails at boot instead of silently pointing at
 * localhost.
 */
export function requiredInProduction(schema: z.ZodType<string, string>, devDefault: string) {
  return process.env.NODE_ENV === "production" ? schema : schema.default(devDefault);
}
