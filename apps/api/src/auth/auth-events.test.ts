import { describe, expect, it } from "vitest";
import { auditEventForAlert, sessionEndReason, sessionMethod } from "./auth-events";

describe("auth audit events", () => {
  it.each([
    ["/sign-in/email", "password"],
    ["/passkey/verify-authentication", "passkey"],
    ["/callback/google", "social"],
    ["/two-factor/verify-totp", "two-factor"],
    ["/email-otp/verify-email", "email-code"],
    ["/admin/impersonate-user", "impersonation"],
    [undefined, "other"],
  ] as const)("a session from %s was obtained by %s", (path, method) => {
    expect(sessionMethod(path)).toBe(method);
  });

  it.each([
    ["/sign-out", "sign-out"],
    ["/revoke-other-sessions", "revoked"],
    ["/change-password", "password-change"],
    ["/email-otp/reset-password", "password-reset"],
    ["/delete-user", "account-deleted"],
    ["/something-else", "other"],
  ] as const)("a session ended by %s ended because of %s", (path, reason) => {
    expect(sessionEndReason(path)).toBe(reason);
  });

  it("maps every security alert to an audit event", () => {
    expect(auditEventForAlert({ event: "two-factor-disabled" }, "u1")).toEqual({
      name: "auth.two_factor_changed.v1",
      payload: { userId: "u1", enabled: false },
    });
    expect(auditEventForAlert({ event: "email-changed" }, "u1").name).toBe("auth.email_changed.v1");
  });
});
