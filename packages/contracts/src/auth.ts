/**
 * Auth rules shared by the API (apps/api/src/auth) and every client form, so the
 * browser rejects exactly what the server would.
 */
import { z } from "zod";

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;
export const NAME_MAX_LENGTH = 100;
export const OTP_LENGTH = 6;
/** Seconds an emailed code stays valid. */
export const OTP_EXPIRES_IN = 5 * 60;

/**
 * "Sudo mode": sensitive changes need a session signed in within this many seconds
 * (better-auth's freshAge, and the API's `fresh` procedures); after it, sign in again.
 */
export const FRESH_SESSION_AGE = 2 * 60 * 60;

/** Digits a texted code has, and how long (seconds) it stays valid. */
export const PHONE_CODE_LENGTH = 6;
export const PHONE_CODE_EXPIRES_IN = 10 * 60;

/** An international phone number in E.164 form: "+" then country code and number. */
export const phoneNumberSchema = z
  .string()
  .trim()
  .transform((value) => value.replaceAll(/[\s().-]/g, ""))
  .pipe(z.string().regex(/^\+[1-9]\d{6,14}$/));
export const phoneCodeSchema = z.string().regex(new RegExp(`^\\d{${PHONE_CODE_LENGTH}}$`));

export const emailSchema = z.email().max(254).toLowerCase();
export const passwordSchema = z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH);
export const nameSchema = z.string().trim().min(1).max(NAME_MAX_LENGTH);
export const otpSchema = z.string().regex(new RegExp(`^\\d{${OTP_LENGTH}}$`));

/**
 * Extra columns on the auth user, in better-auth's field format. The server registers
 * them (`user.additionalFields`) and clients infer them (`inferAdditionalFields`), so
 * `authClient.updateUser({ locale })` and `session.user.timezone` are typed on both
 * sides. No defaultValue: see the sign-up hook in apps/api/src/auth/auth.ts.
 */
export const userAdditionalFields = {
  locale: { type: "string", required: false, input: true },
  timezone: { type: "string", required: false, input: true },
} as const;
