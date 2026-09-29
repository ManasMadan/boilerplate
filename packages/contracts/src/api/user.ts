import * as z from "zod";
import { phoneCodeSchema, phoneNumberSchema } from "../auth";
import { base } from "./base";

export const meSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  email: z.email(),
  image: z.string().nullable(),
  locale: z.string(),
  timezone: z.string(),
  activeOrganizationId: z.uuid().nullable(),
  /** Verified, E.164; null until the user adds one. */
  phoneNumber: z.string().nullable(),
});

const route = (method: "GET" | "POST", path: `/${string}`, summary: string) =>
  base.route({ method, path, tags: ["Account"], summary });

export const userContract = {
  me: route("GET", "/me", "The signed-in user").output(meSchema),
  /**
   * Texts a code to a number the user wants to add (or change to). Needs a recently
   * signed-in session (FRESH_SESSION_REQUIRED otherwise), and is limited per user and
   * per number (RATE_LIMITED).
   */
  sendPhoneCode: route("POST", "/me/phone/code", "Text a verification code")
    .input(z.object({ phoneNumber: phoneNumberSchema }))
    .output(z.object({ expiresInSeconds: z.number().int() })),
  /** Saves the number once the texted code matches (PHONE_CODE_INVALID otherwise). */
  verifyPhone: route("POST", "/me/phone/verify", "Verify and save a phone number")
    .input(z.object({ phoneNumber: phoneNumberSchema, code: phoneCodeSchema }))
    .output(meSchema),
  removePhone: route("POST", "/me/phone/remove", "Remove the phone number").output(meSchema),
  /** A ready avatar upload of the user's (FILE_NOT_READY otherwise), or null to remove it. */
  setAvatar: route("POST", "/me/avatar", "Set or remove the profile picture")
    .input(z.object({ fileId: z.uuid().nullable() }))
    .output(meSchema),
};
