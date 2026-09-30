import { Inject, Module, type OnApplicationShutdown } from "@nestjs/common";
import { env, pushPlatforms } from "../../env";
import { ApnsTransport } from "./apns";
import { FcmTransport } from "./fcm";
import { PushChannel } from "./push.channel";
import { PUSH_TRANSPORTS, type PushTransports } from "./push-transport";
import { WebPushTransport } from "./web-push";

// A platform is on only when all of its variables are set (checked at boot in env.ts).
function createTransports(): PushTransports {
  const transports: PushTransports = {};
  if (pushPlatforms.android) {
    transports.android = new FcmTransport({
      projectId: env.FCM_PROJECT_ID as string,
      clientEmail: env.FCM_CLIENT_EMAIL as string,
      // Keys pasted into env files carry literal "\\n"s.
      privateKey: (env.FCM_PRIVATE_KEY as string).replaceAll("\\n", "\n"),
      ...(env.FCM_TOKEN_URL && { tokenUrl: env.FCM_TOKEN_URL }),
      ...(env.FCM_API_URL && { apiUrl: env.FCM_API_URL }),
    });
  }
  if (pushPlatforms.ios) {
    transports.ios = new ApnsTransport({
      keyId: env.APNS_KEY_ID as string,
      teamId: env.APNS_TEAM_ID as string,
      privateKey: (env.APNS_PRIVATE_KEY as string).replaceAll("\\n", "\n"),
      bundleId: env.APNS_BUNDLE_ID as string,
      url: env.APNS_URL,
    });
  }
  if (pushPlatforms.web) {
    transports.web = new WebPushTransport({
      publicKey: env.VAPID_PUBLIC_KEY as string,
      privateKey: env.VAPID_PRIVATE_KEY as string,
      subject: env.VAPID_SUBJECT as string,
      testOrigin: env.WEB_PUSH_TEST_ORIGIN,
    });
  }
  return transports;
}

export class TransportsLifecycle implements OnApplicationShutdown {
  constructor(@Inject(PUSH_TRANSPORTS) private readonly transports: PushTransports) {}
  async onApplicationShutdown() {
    await Promise.all(Object.values(this.transports).map((transport) => transport?.close?.()));
  }
}

@Module({
  providers: [
    { provide: PUSH_TRANSPORTS, useFactory: createTransports },
    TransportsLifecycle,
    PushChannel,
  ],
  exports: [PushChannel],
})
export class PushModule {}
