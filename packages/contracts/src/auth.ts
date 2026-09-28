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
