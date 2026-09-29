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

/** What changed; an approved app (MCP client) also names the client. */
export type SecurityChange =
  | { event: Exclude<SecurityEvent, "app-connected">; newEmail?: string }
  | { event: "app-connected"; clientId: string };

/** A change and the address its alert goes to. */
export type SecurityAlert = SecurityChange & { email: string };

/** Which security alert (if any) a successful auth request should send, and to whom. */
export function securityAlertFor(ctx: AfterHookContext): SecurityAlert | undefined {
  const user = ctx.context.session?.user;
  const body = (ctx.body ?? {}) as {
    email?: unknown;
    newEmail?: unknown;
    accept?: unknown;
    oauth_query?: unknown;
  };
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
    case "/oauth2/consent": {
      // An app (an MCP client) was approved; the signed request names it.
      const clientId =
        typeof body.oauth_query === "string"
          ? new URLSearchParams(body.oauth_query).get("client_id")
          : null;
      return user && body.accept === true && clientId
        ? { event: "app-connected", email: user.email, clientId }
        : undefined;
    }
    default:
      return undefined;
  }
}
