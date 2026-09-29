/**
 * Web Push (browsers) with VAPID. The device "token" is the browser's PushSubscription
 * (endpoint + keys) as JSON. The web-push library encrypts the payload (RFC 8291) and
 * signs the VAPID header; the request itself goes through fetch, after checking that the
 * endpoint is a browser push service (the subscription came from a client).
 */
import { isWebPushEndpoint } from "@repo/contracts/notifications";
import webPush from "web-push";
import type { PushMessage, PushResult, PushTransport } from "./push-transport";

export interface WebPushConfig {
  publicKey: string;
  privateKey: string;
  /** mailto: or https: contact for push services, required by VAPID. */
  subject: string;
  /** Test hook: an origin (e.g. a local server) accepted besides the browsers' push services. */
  testOrigin?: string | undefined;
}

export class WebPushTransport implements PushTransport {
  constructor(private readonly config: WebPushConfig) {}

  async send(token: string, message: PushMessage): Promise<PushResult> {
    let subscription: webPush.PushSubscription;
    try {
      subscription = JSON.parse(token) as webPush.PushSubscription;
    } catch {
      return { ok: false, gone: true, error: "stored subscription isn't JSON" };
    }
    const endpoint = String(subscription.endpoint);
    const allowed =
      isWebPushEndpoint(endpoint) ||
      (this.config.testOrigin !== undefined && endpoint.startsWith(`${this.config.testOrigin}/`));
    if (!allowed) return { ok: false, gone: true, error: "not a browser push service" };

    const request = webPush.generateRequestDetails(
      subscription,
      JSON.stringify({
        title: message.title,
        body: message.body,
        link: message.link,
        tag: message.collapseKey,
      }),
      {
        vapidDetails: {
          subject: this.config.subject,
          publicKey: this.config.publicKey,
          privateKey: this.config.privateKey,
        },
        TTL: 24 * 3600,
        ...(message.collapseKey && { topic: message.collapseKey.replaceAll(/[^\w-]/g, "") }),
      },
    );
    let response: Response;
    try {
      response = await fetch(request.endpoint, {
        method: request.method,
        headers: request.headers as Record<string, string>,
        body: request.body,
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      return { ok: false, gone: false, error: `Web Push: ${(error as Error).message}` };
    }
    if (response.ok)
      return { ok: true, providerMessageId: response.headers.get("location") ?? undefined };
    const text = await response.text();
    return {
      ok: false,
      // 404/410: the subscription expired or the user revoked permission.
      gone: response.status === 404 || response.status === 410,
      error: `Web Push ${response.status}: ${text.slice(0, 200)}`,
    };
  }
}
