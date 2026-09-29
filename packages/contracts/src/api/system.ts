import { z } from "zod";
import { base } from "./base";

/** Optional subsystems. A feature is on when its configuration is present (see apps/api/src/features.ts). */
export const FEATURES = ["ai", "billing", "captcha", "files", "google"] as const;
export type Feature = (typeof FEATURES)[number];

export const systemContract = {
  info: base
    .route({
      method: "GET",
      path: "/system",
      tags: ["System"],
      summary: "Enabled features and running release",
    })
    .output(
      z.object({
        release: z.string(),
        features: z.record(z.enum(FEATURES), z.boolean()),
        /** Oldest client version this API still supports; older apps must update. */
        minimumClientVersion: z.string(),
        /** Public Turnstile site key when captcha is on; clients render the widget with it. */
        captchaSiteKey: z.string().nullable(),
        /** VAPID public key when browser push is on; browsers subscribe with it. */
        webPushPublicKey: z.string().nullable(),
      }),
    ),
};
