"use client";

import { authErrorKey } from "@repo/client/auth/forms";
import { useTranslations } from "next-intl";

/**
 * A better-auth failure as a translated sentence (see authErrorKey in packages/client).
 * Codes without a translation fall back to a generic sentence; add them to `authErrors`
 * in packages/i18n when a new plugin introduces codes users can hit.
 */
export function useAuthErrorMessage() {
  const t = useTranslations("authErrors");
  return (error: unknown) => {
    const key = authErrorKey(error);
    return key && t.has(key as "generic") ? t(key as "generic") : t("generic");
  };
}
