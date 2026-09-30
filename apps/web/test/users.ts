/**
 * Accounts for browser tests, made through the API's own auth endpoints from the test
 * page, so the session cookie lands in the browser like after a real sign-up.
 */
import { commands } from "vitest/browser";

export interface User {
  id: string;
  name: string;
  email: string;
  password: string;
}

const id = () => crypto.randomUUID();

export const newUser = () => ({
  name: `Web ${id().slice(0, 8)}`,
  email: `web-${id()}@example.com`,
  // Random, so the breached-password check never rejects it.
  password: `pw-${id()}`,
});

/**
 * Calls a better-auth endpoint as the page. The captcha token is Cloudflare's test
 * token, which the API with captcha on accepts with its test secret (and the other
 * API ignores).
 */
export async function auth<T = unknown>(path: string, body: unknown = {}): Promise<T> {
  const response = await fetch(`/api/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-captcha-response": "XXXX.DUMMY.TOKEN.XXXX" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

/** The one-time code the API queued for an email address. */
export async function takeOtp(email: string) {
  const { otp } = await commands.takeNotification<{ otp: string }>("auth.otp", email);
  return otp;
}

/** A new, verified user, signed in on this page. */
export async function signUp(details: Partial<ReturnType<typeof newUser>> = {}): Promise<User> {
  const user = { ...newUser(), ...details };
  await auth("/sign-up/email", user);
  await auth("/email-otp/verify-email", { email: user.email, otp: await takeOtp(user.email) });
  const session = await fetch("/api/auth/get-session").then((r) => r.json());
  return { ...user, id: session.user.id };
}

export const signOut = () => auth("/sign-out");

/** Turns on two-step verification for the signed-in user; returns its secret and backup codes. */
export async function enableTwoFactor(user: User) {
  const { totpURI, backupCodes } = await auth<{ totpURI: string; backupCodes: string[] }>(
    "/two-factor/enable",
    { password: user.password },
  );
  const secret = new URL(totpURI).searchParams.get("secret") as string;
  await auth("/two-factor/verify-totp", { code: await commands.totp(secret) });
  return { secret, backupCodes };
}

/** Calls an auth endpoint until the API refuses it as too many attempts (per IP or address). */
export async function rateLimit(path: string, body: unknown) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const response = await fetch(`/api/auth${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-captcha-response": "XXXX.DUMMY.TOKEN.XXXX",
      },
      body: JSON.stringify(body),
    });
    if (response.status === 429) return;
  }
  throw new Error(`${path} was never rate limited`);
}
