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

    // Push. Each platform is on when its variables are set (all of them, or none).
    // Android: a Firebase service account (Project settings → Service accounts).
    FCM_PROJECT_ID: z.string().min(1).optional(),
    FCM_CLIENT_EMAIL: z.email().optional(),
    FCM_PRIVATE_KEY: z.string().min(1).optional(),
    // iOS: an APNs auth key (.p8) from the Apple Developer account.
    APNS_KEY_ID: z.string().min(1).optional(),
    APNS_TEAM_ID: z.string().min(1).optional(),
    APNS_PRIVATE_KEY: z.string().min(1).optional(),
    APNS_BUNDLE_ID: z.string().min(1).optional(),
    APNS_URL: z.url().default("https://api.push.apple.com"),
    // Browsers: VAPID keys (npx web-push generate-vapid-keys); the public one also goes to apps/api.
    VAPID_PUBLIC_KEY: z.string().min(1).optional(),
    VAPID_PRIVATE_KEY: z.string().min(1).optional(),
    VAPID_SUBJECT: z
      .string()
      .regex(/^(mailto:|https:)/)
      .optional(),
    // Test hooks: where FCM's token and send endpoints live (Google's by default).
    FCM_TOKEN_URL: z.url().optional(),
    FCM_API_URL: z.url().optional(),
    // Test hook: an origin accepted as a Web Push endpoint besides the browsers' services.
    WEB_PUSH_TEST_ORIGIN: z.url().optional(),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});

// A misconfigured provider must fail at boot, not on the first email.
if (env.EMAIL_PROVIDER === "resend" && !env.RESEND_API_KEY) {
  throw new Error("EMAIL_PROVIDER=resend requires RESEND_API_KEY");
}

// Test hooks redirect providers to local servers; production must use the real ones.
if (
  env.NODE_ENV === "production" &&
  (env.FCM_TOKEN_URL || env.FCM_API_URL || env.WEB_PUSH_TEST_ORIGIN)
) {
  throw new Error("FCM_TOKEN_URL, FCM_API_URL and WEB_PUSH_TEST_ORIGIN are for tests only");
}

/** Push platforms whose configuration is complete; a partial one fails at boot. */
export const pushPlatforms = {
  android: complete("FCM", [env.FCM_PROJECT_ID, env.FCM_CLIENT_EMAIL, env.FCM_PRIVATE_KEY]),
  ios: complete("APNs", [
    env.APNS_KEY_ID,
    env.APNS_TEAM_ID,
    env.APNS_PRIVATE_KEY,
    env.APNS_BUNDLE_ID,
  ]),
  web: complete("Web Push", [env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY, env.VAPID_SUBJECT]),
};

function complete(name: string, values: (string | undefined)[]) {
  const set = values.filter(Boolean).length;
  if (set !== 0 && set !== values.length)
    throw new Error(`${name} needs all of its variables set, or none`);
  return set === values.length;
}
