/**
 * What the sign-in forms of every app share: the validation rules (from
 * packages/contracts, the same ones the API enforces) and which translated sentence an
 * auth failure shows. Apps pass their translator (next-intl on web, use-intl on mobile).
 */
import {
  emailSchema,
  nameSchema,
  otpSchema,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  phoneNumberSchema,
} from "@repo/contracts/auth";
import { z } from "zod";

/** The `validation.*` messages the schemas use. */
export type ValidationTranslator = (
  key: "email" | "passwordMin" | "passwordMax" | "required" | "nameMin" | "code" | "phone",
  values?: Record<string, number>,
) => string;

const matches = (schema: z.ZodType) => (value: string) => schema.safeParse(value).success;

export function authFormSchemas(t: ValidationTranslator) {
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
 * The `authErrors.*` key for a better-auth failure (INVALID_EMAIL_OR_PASSWORD,
 * INVALID_OTP, ...), or undefined for "show the generic sentence". Accepts anything
 * thrown or returned: only `code`, `error` (OAuth endpoints) and `status` are read.
 * The server's English message is never shown.
 */
export function authErrorKey(error: unknown): string | undefined {
  const {
    code,
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
      : typeof code === "string"
        ? code
        : typeof oauthError === "string"
          ? oauthError
          : undefined;
  return raw && (ALIASES[raw] ?? raw);
}
