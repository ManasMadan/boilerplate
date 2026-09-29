/**
 * Which optional subsystems are enabled. A feature is on exactly when its configuration
 * is present, so there is one switch per feature and nothing to keep in sync. A
 * half-configured feature (e.g. a Google client id without its secret) fails at boot.
 *
 * Disabled features' procedures answer FEATURE_DISABLED, and clients read the same map
 * from `system.info` to hide their UI.
 */
import type { Feature } from "@repo/contracts/api";
import { env } from "./env";

function pair(name: string, a: string | undefined, b: string | undefined) {
  if (Boolean(a) !== Boolean(b))
    throw new Error(`${name} needs both of its variables set, or neither`);
  return Boolean(a && b);
}

export const features: Record<Feature, boolean> = {
  google: pair(
    "Google sign-in (GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET)",
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
  ),
  ai: Boolean(env.AI_URL),
  captcha: pair(
    "Captcha (TURNSTILE_SITE_KEY/TURNSTILE_SECRET_KEY)",
    env.TURNSTILE_SITE_KEY,
    env.TURNSTILE_SECRET_KEY,
  ),
  files: Boolean(env.S3_BUCKET),
  // Wired in a later step; off until its configuration exists.
  billing: false,
};
