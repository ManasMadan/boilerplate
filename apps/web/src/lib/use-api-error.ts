"use client";

import { errorMessageKey, errorParams } from "@repo/client";
import { loosely } from "@repo/i18n";
import { useTranslations } from "next-intl";

/** A translated sentence for any failed API call (never the server's English message). */
export function useApiErrorMessage() {
  const t = loosely(useTranslations());
  return (error: unknown) => t(errorMessageKey(error), errorParams(error));
}
