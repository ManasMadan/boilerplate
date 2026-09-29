"use client";

/**
 * Form schemas built from the shared auth rules in packages/contracts (the same rules
 * the API enforces), with messages in the user's language.
 */
import {
  emailSchema,
  nameSchema,
  otpSchema,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  phoneNumberSchema,
} from "@repo/contracts/auth";
import { useTranslations } from "next-intl";
import { z } from "zod";

const matches = (schema: z.ZodType) => (value: string) => schema.safeParse(value).success;

export function useAuthSchemas() {
  const t = useTranslations("validation");
  return {
    email: z.string().trim().refine(matches(emailSchema), t("email")),
    /** For choosing a password: the server's length limits. */
    newPassword: z
      .string()
      .min(PASSWORD_MIN_LENGTH, t("passwordMin", { min: PASSWORD_MIN_LENGTH }))
      .max(PASSWORD_MAX_LENGTH, t("passwordMax", { max: PASSWORD_MAX_LENGTH })),
    /** For entering an existing password: only non-empty (never hint at the rules). */
    password: z.string().min(1, t("required")),
    name: z.string().refine(matches(nameSchema), t("nameMin")),
    otp: z.string().refine(matches(otpSchema), t("code")),
    /** E.164, typed with or without spaces and dashes. */
    phone: z.string().refine(matches(phoneNumberSchema), t("phone")),
  };
}
