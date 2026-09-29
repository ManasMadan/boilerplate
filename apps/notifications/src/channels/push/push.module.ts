import { Inject, Module, type OnApplicationShutdown } from "@nestjs/common";
import { env, pushPlatforms } from "../../env";
import { ApnsTransport } from "./apns";
import { FcmTransport } from "./fcm";
import { PushChannel } from "./push.channel";
import { PUSH_TRANSPORTS, type PushTransports } from "./push-transport";
import { WebPushTransport } from "./web-push";

function createTransports(): PushTransports {
  const transports: PushTransports = {};
  if (pushPlatforms.android && env.FCM_PROJECT_ID && env.FCM_CLIENT_EMAIL && env.FCM_PRIVATE_KEY) {
    transports.android = new FcmTransport({
      projectId: env.FCM_PROJECT_ID,
      clientEmail: env.FCM_CLIENT_EMAIL,
      // Keys pasted into env files carry literal "\\n"s.
      privateKey: env.FCM_PRIVATE_KEY.replaceAll("\\n", "\n"),
      ...(env.FCM_TOKEN_URL && { tokenUrl: env.FCM_TOKEN_URL }),
      ...(env.FCM_API_URL && { apiUrl: env.FCM_API_URL }),
    });
  }
  if (
    pushPlatforms.ios &&
    env.APNS_KEY_ID &&
    env.APNS_TEAM_ID &&
    env.APNS_PRIVATE_KEY &&
    env.APNS_BUNDLE_ID
  ) {
    transports.ios = new ApnsTransport({
      keyId: env.APNS_KEY_ID,
      teamId: env.APNS_TEAM_ID,
      privateKey: env.APNS_PRIVATE_KEY.replaceAll("\\n", "\n"),
      bundleId: env.APNS_BUNDLE_ID,
      url: env.APNS_URL,
    });
  }
  if (pushPlatforms.web && env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT) {
    transports.web = new WebPushTransport({
      publicKey: env.VAPID_PUBLIC_KEY,
      privateKey: env.VAPID_PRIVATE_KEY,
      subject: env.VAPID_SUBJECT,
      testOrigin: env.WEB_PUSH_TEST_ORIGIN,
    });
  }
  return transports;
}

class TransportsLifecycle implements OnApplicationShutdown {
  constructor(@Inject(PUSH_TRANSPORTS) private readonly transports: PushTransports) {}
  onApplicationShutdown() {
    (this.transports.ios as ApnsTransport | undefined)?.close();
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
