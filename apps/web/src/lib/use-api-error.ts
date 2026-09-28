"use client";

import { errorMessageKey, errorParams } from "@repo/client";
import { useTranslations } from "next-intl";

/** A translated sentence for any failed API call (never the server's English message). */
export function useApiErrorMessage() {
  const t = useTranslations();
  return (error: unknown) => t(errorMessageKey(error), errorParams(error));
}
