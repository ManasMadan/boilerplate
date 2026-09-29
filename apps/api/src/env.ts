/**
 * Validated environment for the API service. Shared variables come from
 * @repo/nest-common's fragments. Import `env` instead of reading `process.env`: a missing
 * or malformed value stops the process at boot with a readable message.
 *
 * Optional subsystems (Google sign-in, AI, captcha, ...) are enabled by setting their
 * variables; see src/features.ts. Add new variables here, to .env.example and to
 * docs/environment.md in the same change.
 */
import { coreEnv, databaseEnv, port, redisEnv, storageEnv } from "@repo/nest-common";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    ...coreEnv,
    ...databaseEnv("API"),
    ...redisEnv,
    // Optional: file uploads (profile pictures), on when S3_BUCKET is set.
    ...storageEnv,
    PORT: port(3001),

    BETTER_AUTH_SECRET: z.string().min(32, "Generate one with: openssl rand -base64 32"),
    /** Public URL of this API; OAuth callbacks and cookies are derived from it. */
    BETTER_AUTH_URL: z.url(),
    /** Public URL of the web app: the only browser origin allowed to call the API. */
    WEB_URL: z.url(),

    /** Oldest web/mobile app version still supported; older clients get CLIENT_OUTDATED. */
    MINIMUM_CLIENT_VERSION: z.string().default("0.0.0"),

    // Optional: Google sign-in.
    GOOGLE_CLIENT_ID: z.string().min(1).optional(),
    GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
    // Optional: Cloudflare Turnstile on sign-up, emailed codes and password reset. The
    // site key is public (browsers render the widget with it); the secret stays here.
    TURNSTILE_SITE_KEY: z.string().min(1).optional(),
    TURNSTILE_SECRET_KEY: z.string().min(1).optional(),
    // Browser push: the public half of apps/notifications' VAPID key pair.
    VAPID_PUBLIC_KEY: z.string().min(1).optional(),
    // Optional: billing (Stripe). On when STRIPE_SECRET_KEY is set, with both prices.
    STRIPE_SECRET_KEY: z
      .string()
      .regex(/^(sk|rk)_(test|live)_/)
      .optional(),
    STRIPE_PRICE_PRO_MONTHLY: z.string().startsWith("price_").optional(),
    STRIPE_PRICE_PRO_YEARLY: z.string().startsWith("price_").optional(),
    // Free trial for an organization's first subscription; 0 turns trials off.
    STRIPE_TRIAL_DAYS: z.coerce.number().int().min(0).max(730).default(14),
    // Test hook: where Stripe's API lives (packages/fake-stripe).
    STRIPE_API_URL: z.url().optional(),
    // Checks one-click unsubscribe links (apps/notifications signs them with the same secret).
    UNSUBSCRIBE_SECRET: z.string().min(32),
    // Encrypts webhook signing secrets at rest (apps/webhooks decrypts them to sign).
    ENCRYPTION_KEYS: z.string().min(1),
    // Exact private IPs webhook endpoints may use, for local development and tests only.
    WEBHOOK_ALLOWED_PRIVATE_ADDRESSES: z
      .string()
      .default("")
      .transform((value) =>
        value
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean),
      ),
    // Optional: the Python AI service.
    AI_URL: z.url().optional(),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});

export type Env = typeof env;

if (env.NODE_ENV === "production" && env.STRIPE_API_URL) {
  throw new Error("STRIPE_API_URL is for tests only");
}

if (env.NODE_ENV === "production" && env.WEBHOOK_ALLOWED_PRIVATE_ADDRESSES.length > 0) {
  throw new Error("WEBHOOK_ALLOWED_PRIVATE_ADDRESSES must be empty in production");
}
