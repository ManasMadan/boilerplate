/**
 * Standard Webhooks (standardwebhooks.com) signing, so customers can verify our
 * deliveries with any of its libraries:
 *
 *   webhook-id: <message id>           the same on every retry (their idempotency key)
 *   webhook-timestamp: <unix seconds>   receivers reject old ones (replay protection)
 *   webhook-signature: v1,<base64 HMAC-SHA256(secret, "<id>.<timestamp>.<body>")>
 *
 * Secrets look like `whsec_<base64 of 24 random bytes>`; the key is the decoded part.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const PREFIX = "whsec_";

export function generateSecret(): string {
  return `${PREFIX}${randomBytes(24).toString("base64")}`;
}

function keyOf(secret: string) {
  if (!secret.startsWith(PREFIX)) throw new Error("Webhook secrets start with whsec_");
  return Buffer.from(secret.slice(PREFIX.length), "base64");
}

function sign(secret: string, messageId: string, timestamp: number, body: string) {
  const digest = createHmac("sha256", keyOf(secret))
    .update(`${messageId}.${timestamp}.${body}`)
    .digest("base64");
  return `v1,${digest}`;
}

/** The headers for one delivery attempt. */
export function signatureHeaders(
  secret: string,
  messageId: string,
  body: string,
  now = Date.now(),
) {
  const timestamp = Math.floor(now / 1000);
  return {
    "webhook-id": messageId,
    "webhook-timestamp": String(timestamp),
    "webhook-signature": sign(secret, messageId, timestamp, body),
  };
}

/** Constant-time check of one signature (what receivers do; used in our tests). */
export function verify(
  secret: string,
  messageId: string,
  timestamp: number,
  body: string,
  signature: string,
) {
  const expected = Buffer.from(sign(secret, messageId, timestamp, body));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
