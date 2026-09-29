/**
 * Validated environment for the notification service. Shared variables come from
 * @repo/nest-common's fragments; add new ones here, to .env.example and to
 * docs/environment.md.
 */
import { coreEnv, databaseEnv, port, redisEnv, requiredInProduction } from "@repo/nest-common";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    ...coreEnv,
    ...databaseEnv("NOTIFICATIONS"),
    ...redisEnv,
    // Only serves health checks; the work arrives through the queues.
    PORT: port(3003),

    // Jobs one process handles at once, per queue. Scale out with more replicas.
    NOTIFICATIONS_CRITICAL_CONCURRENCY: z.coerce.number().int().positive().default(20),
    NOTIFICATIONS_BULK_CONCURRENCY: z.coerce.number().int().positive().default(5),

    // smtp: any SMTP server (Mailpit locally; SES, Postmark or SendGrid in production).
    // resend: Resend's HTTP API.
    EMAIL_PROVIDER: z.enum(["smtp", "resend"]).default("smtp"),
    SMTP_URL: requiredInProduction(z.url({ protocol: /^smtps?$/ }), "smtp://localhost:1025"),
    RESEND_API_KEY: z.string().startsWith("re_").optional(),
    EMAIL_FROM: requiredInProduction(z.string().min(3), "Boilerplate <no-reply@localhost>"),

    // The web app's public URL, for links in messages (settings, unsubscribe).
    WEB_URL: requiredInProduction(z.url(), "http://localhost:3000"),
    // Signs one-click unsubscribe links (apps/api verifies them with the same secret).
    UNSUBSCRIBE_SECRET: z.string().min(32),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});

// A misconfigured provider must fail at boot, not on the first email.
if (env.EMAIL_PROVIDER === "resend" && !env.RESEND_API_KEY) {
  throw new Error("EMAIL_PROVIDER=resend requires RESEND_API_KEY");
}
