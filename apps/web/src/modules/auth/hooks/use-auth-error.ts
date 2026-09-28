"use client";

import { useTranslations } from "next-intl";

export interface AuthError {
  code?: string | undefined;
  status?: number | undefined;
}

/** The user dismissed the browser's passkey prompt: not an error worth reporting. */
export const isCancelled = (error: AuthError | null | undefined) =>
  error?.code === "AUTH_CANCELLED" || error?.code === "REGISTRATION_CANCELLED";

/**
 * better-auth reports failures with codes (INVALID_EMAIL_OR_PASSWORD, INVALID_OTP, ...).
 * This turns one into a translated sentence; the server's English message is never shown.
 * Codes without a translation fall back to a generic sentence; add them to `authErrors`
 * in packages/i18n when a new plugin introduces codes users can hit.
 */
export function useAuthErrorMessage() {
  const t = useTranslations("authErrors");
  return (error: AuthError | null | undefined) => {
    // The rate limiter answers 429 without a code.
    const code = error?.status === 429 ? "RATE_LIMITED" : error?.code;
    return code && t.has(code as "generic") ? t(code as "generic") : t("generic");
  };
}
