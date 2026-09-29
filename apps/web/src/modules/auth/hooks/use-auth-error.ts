"use client";

import { useTranslations } from "next-intl";

/**
 * Several codes mean the same thing to a user. Passkey prompts in particular fail in
 * browser-specific ways: dismissing the dialog surfaces as the browser's NotAllowedError
 * (ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY), an aborted ceremony, or the plugin's own
 * *_CANCELLED codes.
 */
const ALIASES: Record<string, string> = {
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: "USER_ALREADY_EXISTS",
  TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE: "TOO_MANY_ATTEMPTS",
  SESSION_NOT_FRESH: "SESSION_EXPIRED",
  AUTH_CANCELLED: "PASSKEY_CANCELLED",
  REGISTRATION_CANCELLED: "PASSKEY_CANCELLED",
  ERROR_CEREMONY_ABORTED: "PASSKEY_CANCELLED",
  ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY: "PASSKEY_CANCELLED",
  ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED: "PREVIOUSLY_REGISTERED",
  ORGANIZATION_MEMBERSHIP_LIMIT_REACHED: "ENTITLEMENT_REQUIRED",
  // OAuth errors (the `error` field): the signed request an app sent the user with has
  // expired (it's valid for 10 minutes) or was altered.
  invalid_signature: "OAUTH_REQUEST_EXPIRED",
};

/**
 * better-auth reports failures with codes (INVALID_EMAIL_OR_PASSWORD, INVALID_OTP, ...).
 * This turns one into a translated sentence; the server's English message is never shown.
 * Codes without a translation fall back to a generic sentence; add them to `authErrors`
 * in packages/i18n when a new plugin introduces codes users can hit.
 */
export function useAuthErrorMessage() {
  const t = useTranslations("authErrors");
  // Accepts anything thrown or returned: only `code`, `error` (OAuth endpoints) and
  // `status` are read, if present.
  return (error: unknown) => {
    const {
      code: rawCode,
      error: oauthError,
      status,
    } = (typeof error === "object" && error !== null ? error : {}) as {
      code?: unknown;
      error?: unknown;
      status?: unknown;
    };
    // The rate limiter answers 429 without a code.
    const raw =
      status === 429
        ? "RATE_LIMITED"
        : typeof rawCode === "string"
          ? rawCode
          : typeof oauthError === "string"
            ? oauthError
            : undefined;
    const code = raw && (ALIASES[raw] ?? raw);
    return code && t.has(code as "generic") ? t(code as "generic") : t("generic");
  };
}
