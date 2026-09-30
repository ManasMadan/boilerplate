/**
 * Apple Push Notification service over HTTP/2 with token-based auth: a short-lived ES256
 * JWT (key id + team id), refreshed every 50 minutes as Apple requires. No SDK: one
 * HTTP/2 request per notification on a kept-open connection.
 */
import { createSign } from "node:crypto";
import { type ClientHttp2Session, connect } from "node:http2";
import type { PushMessage, PushResult, PushTransport } from "./push-transport";

export interface ApnsConfig {
  keyId: string;
  teamId: string;
  /** The .p8 key's contents. */
  privateKey: string;
  bundleId: string;
  /** api.push.apple.com, or the sandbox for development builds; overridable for tests. */
  url: string;
  /** How long one notification may take (default 10 s). */
  timeoutMs?: number;
}

const REFRESH_MS = 50 * 60_000;

export class ApnsTransport implements PushTransport {
  private jwt: { value: string; issuedAt: number } | undefined;
  private session: ClientHttp2Session | undefined;

  constructor(private readonly config: ApnsConfig) {}

  private token() {
    if (this.jwt && Date.now() - this.jwt.issuedAt < REFRESH_MS) return this.jwt.value;
    const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: this.config.keyId })).toString(
      "base64url",
    );
    const claims = Buffer.from(
      JSON.stringify({ iss: this.config.teamId, iat: Math.floor(Date.now() / 1000) }),
    ).toString("base64url");
    const signature = createSign("SHA256")
      .update(`${header}.${claims}`)
      .sign({ key: this.config.privateKey, dsaEncoding: "ieee-p1363" })
      .toString("base64url");
    this.jwt = { value: `${header}.${claims}.${signature}`, issuedAt: Date.now() };
    return this.jwt.value;
  }

  private connection() {
    if (!this.session || this.session.closed || this.session.destroyed) {
      this.session = connect(this.config.url);
      this.session.on("error", () => this.session?.destroy());
    }
    return this.session;
  }

  send(token: string, message: PushMessage): Promise<PushResult> {
    const body = JSON.stringify({
      aps: { alert: { title: message.title, body: message.body }, sound: "default" },
      ...(message.link && { link: message.link }),
    });
    return new Promise((resolve) => {
      const request = this.connection().request({
        ":method": "POST",
        ":path": `/3/device/${token}`,
        authorization: `bearer ${this.token()}`,
        "apns-topic": this.config.bundleId,
        "apns-push-type": "alert",
        ...(message.collapseKey && { "apns-collapse-id": message.collapseKey.slice(0, 64) }),
        "content-type": "application/json",
      });
      let status = 0;
      let text = "";
      request.setTimeout(this.config.timeoutMs ?? 10_000, () => {
        request.close();
        resolve({ ok: false, gone: false, error: "APNs timed out" });
      });
      request.on("response", (headers) => {
        status = Number(headers[":status"]);
      });
      request.on("data", (chunk) => {
        text += chunk;
      });
      request.on("end", () => {
        if (status === 200) return resolve({ ok: true });
        // 410 Unregistered, or 400 BadDeviceToken: the token is dead.
        const gone =
          status === 410 || text.includes("BadDeviceToken") || text.includes("Unregistered");
        resolve({ ok: false, gone, error: `APNs ${status}: ${text.slice(0, 200)}` });
      });
      request.on("error", (error) => resolve({ ok: false, gone: false, error: error.message }));
      request.end(body);
    });
  }

  close() {
    this.session?.close();
  }
}
