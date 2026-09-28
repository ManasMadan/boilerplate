/**
 * Validated environment for the API service. Shared variables come from
 * @repo/nest-common's fragments. Import `env` instead of reading `process.env`: a missing
 * or malformed value stops the process at boot with a readable message.
 *
 * Optional subsystems (Google sign-in, AI, captcha, ...) are enabled by setting their
 * variables; see src/features.ts. Add new variables here, to .env.example and to
 * docs/environment.md in the same change.
 */
import { coreEnv, databaseEnv, port, redisEnv } from "@repo/nest-common";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    ...coreEnv,
    ...databaseEnv("API"),
    ...redisEnv,
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
    // Optional: the Python AI service.
    AI_URL: z.url().optional(),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});

export type Env = typeof env;
