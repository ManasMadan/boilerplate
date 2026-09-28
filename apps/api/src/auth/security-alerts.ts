/**
 * Which account changes email the owner a security alert. Kept apart from the auth config
 * so the rules are unit-testable; auth.ts calls this from an after-hook on every request.
 */
import type { SecurityEvent } from "@repo/jobs";

interface AfterHookContext {
  path?: string | undefined;
  body?: unknown;
  context: { session?: { user: { email: string; twoFactorEnabled?: boolean | null } } | null };
}

/** Which security alert (if any) a successful auth request should send, and to whom. */
export function securityAlertFor(
  ctx: AfterHookContext,
): { event: SecurityEvent; email: string; newEmail?: string } | undefined {
  const user = ctx.context.session?.user;
  const body = (ctx.body ?? {}) as { email?: unknown; newEmail?: unknown };
  switch (ctx.path) {
    case "/change-password":
      return user && { event: "password-changed", email: user.email };
    case "/email-otp/reset-password":
      return typeof body.email === "string"
        ? { event: "password-reset", email: body.email.toLowerCase() }
        : undefined;
    case "/email-otp/change-email":
      // To the old address: the session still holds the pre-change user.
      return user && typeof body.newEmail === "string"
        ? { event: "email-changed", email: user.email, newEmail: body.newEmail.toLowerCase() }
        : undefined;
    case "/two-factor/verify-totp":
      // With a session this confirms setup; during sign-in there is no session yet.
      return user && !user.twoFactorEnabled
        ? { event: "two-factor-enabled", email: user.email }
        : undefined;
    case "/two-factor/disable":
      return user && { event: "two-factor-disabled", email: user.email };
    case "/passkey/verify-registration":
      return user && { event: "passkey-added", email: user.email };
    default:
      return undefined;
  }
}
