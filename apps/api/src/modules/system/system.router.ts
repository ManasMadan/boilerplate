import { env } from "../../env";
import { features } from "../../features";
import type { Procedures } from "../../rpc/procedures";

export const systemRouter = ({ base }: Procedures) => ({
  info: base.system.info.handler(() => ({
    release: env.RELEASE,
    features,
    minimumClientVersion: env.MINIMUM_CLIENT_VERSION,
    captchaSiteKey: features.captcha ? (env.TURNSTILE_SITE_KEY ?? null) : null,
    webPushPublicKey: env.VAPID_PUBLIC_KEY ?? null,
  })),
});
