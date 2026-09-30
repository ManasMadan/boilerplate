/**
 * Firebase Cloud Messaging, HTTP v1 API, authenticated as a service account: a JWT signed
 * with its private key is exchanged for an OAuth access token (cached until shortly
 * before it expires). No SDK: the protocol is two HTTPS calls.
 */
import { createSign } from "node:crypto";
import type { PushMessage, PushResult, PushTransport } from "./push-transport";

export interface FcmConfig {
  projectId: string;
  clientEmail: string;
  privateKey: string;
  /** Overridable for tests; Google's endpoints by default. */
  tokenUrl?: string;
  apiUrl?: string;
}

const base64url = (value: string | Buffer) => Buffer.from(value).toString("base64url");

export class FcmTransport implements PushTransport {
  private accessToken: { value: string; expiresAt: number } | undefined;

  constructor(private readonly config: FcmConfig) {}

  private async token() {
    if (this.accessToken && this.accessToken.expiresAt > Date.now() + 60_000)
      return this.accessToken.value;
    const tokenUrl = this.config.tokenUrl ?? "https://oauth2.googleapis.com/token";
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: this.config.clientEmail,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: tokenUrl,
      iat: now,
      exp: now + 3600,
    };
    const unsigned = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(JSON.stringify(claims))}`;
    const signature = createSign("RSA-SHA256").update(unsigned).sign(this.config.privateKey);
    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${unsigned}.${base64url(signature)}`,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok)
      throw new Error(`FCM auth failed: ${response.status} ${await response.text()}`);
    const body = (await response.json()) as { access_token: string; expires_in: number };
    this.accessToken = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return body.access_token;
  }

  async send(token: string, message: PushMessage): Promise<PushResult> {
    const apiUrl = this.config.apiUrl ?? "https://fcm.googleapis.com";
    const response = await fetch(`${apiUrl}/v1/projects/${this.config.projectId}/messages:send`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await this.token()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        message: {
          token,
          notification: { title: message.title, body: message.body },
          data: message.link ? { link: message.link } : {},
          android: message.collapseKey ? { collapse_key: message.collapseKey } : undefined,
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok)
      return { ok: true, providerMessageId: ((await response.json()) as { name: string }).name };
    const text = await response.text();
    return {
      ok: false,
      gone: tokenIsDead(response.status, text),
      error: `FCM ${response.status}: ${text.slice(0, 200)}`,
    };
  }
}

/**
 * Whether FCM's error means the token will never work: UNREGISTERED (404), or
 * INVALID_ARGUMENT naming the token field (a malformed token). INVALID_ARGUMENT about
 * anything else is our message's fault, and forgetting the device for it would be wrong.
 */
export function tokenIsDead(status: number, body: string): boolean {
  if (status === 404 || body.includes("UNREGISTERED")) return true;
  let error: { status?: string; details?: { fieldViolations?: { field?: string }[] }[] };
  try {
    ({ error } = JSON.parse(body) as { error: typeof error });
  } catch {
    return false;
  }
  return (
    error?.status === "INVALID_ARGUMENT" &&
    (error.details ?? []).some((detail) =>
      (detail.fieldViolations ?? []).some((violation) => violation.field === "message.token"),
    )
  );
}
