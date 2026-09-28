/**
 * Authentication (better-auth): the one place sign-in, sessions, organizations and
 * account security are configured. Clients use the better-auth client from
 * packages/client; oRPC procedures read the session through the `authed` middleware.
 *
 * Sessions are server-side and revocable. Each session lives in Redis (fast lookups on
 * every request) with a durable copy in Postgres (device list, audit). There is no
 * cookie cache: signing out or revoking a session deletes it, so the same cookie is
 * rejected on the very next request.
 *
 * Emails (sign-in codes, invitations) are never sent from here. They are queued for the
 * notification service, rendered in the recipient's language, and delivered with
 * retries, so a slow email provider can never slow down or fail a sign-in.
 *
 * After adding or removing a plugin, regenerate the auth tables (db-change skill).
 */
import { randomUUID } from "node:crypto";
import { apiKey } from "@better-auth/api-key";
import { passkey } from "@better-auth/passkey";
import { redisStorage } from "@better-auth/redis-storage";
import {
  NAME_MAX_LENGTH,
  OTP_EXPIRES_IN,
  OTP_LENGTH,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from "@repo/contracts/auth";
import type { Db } from "@repo/db";
import { isLocale, type Locale, negotiateLocale } from "@repo/i18n";
import type { JobMeta, Producer } from "@repo/jobs";
import { currentContext } from "@repo/nest-common";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { captcha } from "better-auth/plugins";
import { admin } from "better-auth/plugins/admin";
import { emailOTP } from "better-auth/plugins/email-otp";
import { haveIBeenPwned } from "better-auth/plugins/haveibeenpwned";
import { organization } from "better-auth/plugins/organization";
import { twoFactor } from "better-auth/plugins/two-factor";
import type { Redis } from "ioredis";
import type { Env } from "../env";
import { features } from "../features";

export interface AuthDependencies {
  env: Env;
  db: Db;
  redis: Redis;
  notifications: Producer<"notifications-critical">;
}

const MINUTE = 60;
const DAY = 24 * 60 * MINUTE;
const INVITATION_DAYS = 7;

/** Request metadata copied onto queued emails so their logs share the request id. */
function jobMeta(): JobMeta {
  const context = currentContext();
  return {
    ...(context?.requestId && { requestId: context.requestId }),
    ...(context?.userId && { userId: context.userId }),
  };
}

export function createAuth({ env, db, redis, notifications }: AuthDependencies) {
  const webOrigin = new URL(env.WEB_URL);

  /** Language for an email address: the account's saved locale, else the browser's. */
  async function localeFor(email: string, headers: Headers | undefined): Promise<Locale> {
    const user = await db.user.findUnique({ where: { email }, select: { locale: true } });
    if (user && isLocale(user.locale)) return user.locale;
    return negotiateLocale(headers?.get("x-locale") ?? headers?.get("accept-language"));
  }

  const options = {
    appName: "Boilerplate",
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    // Browsers may only call auth endpoints from the web app's origin (CSRF protection).
    trustedOrigins: [env.WEB_URL],

    database: prismaAdapter(db, { provider: "postgresql" }),
    // Session lookups hit Redis, not Postgres, on every request.
    secondaryStorage: redisStorage({ client: redis, keyPrefix: "auth:" }),
    advanced: {
      // Ids come from Postgres (uuidv7() defaults), like every other table.
      database: { generateId: false },
      // Behind the gateway, the client IP arrives in X-Forwarded-For (trusted proxies only).
      ipAddress: { ipAddressHeaders: ["x-forwarded-for"] },
    },

    session: {
      expiresIn: 7 * DAY,
      // Sliding expiry: an active session is extended at most once a day.
      updateAge: DAY,
      // Keep the durable copy so users can see and revoke their devices.
      storeSessionInDatabase: true,
      // Changing email, password, 2FA or deleting the account requires a recent sign-in.
      freshAge: 15 * MINUTE,
      // Deliberately no cookieCache: a cached session would outlive sign-out/revocation.
    },

    rateLimit: {
      enabled: true,
      storage: "secondary-storage",
      window: MINUTE,
      max: 100,
      // Brute-force protection on the endpoints that guess secrets.
      customRules: {
        "/sign-in/email": { window: MINUTE, max: 5 },
        "/sign-up/email": { window: MINUTE, max: 5 },
        "/email-otp/*": { window: MINUTE, max: 5 },
        "/two-factor/*": { window: MINUTE, max: 5 },
        "/forget-password/*": { window: MINUTE, max: 3 },
      },
    },

    emailAndPassword: {
      enabled: true,
      minPasswordLength: PASSWORD_MIN_LENGTH,
      maxPasswordLength: PASSWORD_MAX_LENGTH,
      // No session until the email is verified; every authenticated user has a real address.
      requireEmailVerification: true,
      // A password reset signs out every device (the reset might be recovering a stolen account).
      revokeSessionsOnPasswordReset: true,
    },
    emailVerification: {
      // Trying to sign in unverified sends a fresh code, so lost emails are self-service.
      sendOnSignIn: true,
      autoSignInAfterVerification: true,
    },

    user: {
      additionalFields: {
        // Captured from the browser at sign-up and normalised in databaseHooks below. No
        // defaultValue here: it would be filled in before the hook runs and hide the
        // browser's language; the database supplies the defaults.
        locale: { type: "string", required: false, input: true },
        timezone: { type: "string", required: false, input: true },
      },
      deleteUser: { enabled: true },
      changeEmail: { enabled: true },
    },

    account: {
      // OAuth access/refresh tokens are encrypted at rest.
      encryptOAuthTokens: true,
      accountLinking: { enabled: true, trustedProviders: ["google"] },
    },

    socialProviders: {
      ...(features.google &&
        env.GOOGLE_CLIENT_ID &&
        env.GOOGLE_CLIENT_SECRET && {
          google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET },
        }),
    },

    databaseHooks: {
      user: {
        create: {
          // Normalise client-supplied preferences instead of trusting them. Without an
          // explicit locale, the browser's language decides (so the verification email
          // sent right after sign-up is already in the right language).
          before: async (user, ctx) => ({
            data: {
              ...user,
              name: String(user.name).trim().slice(0, NAME_MAX_LENGTH),
              locale: negotiateLocale(
                typeof user.locale === "string" && user.locale
                  ? user.locale
                  : (ctx?.headers?.get("x-locale") ?? ctx?.headers?.get("accept-language")),
              ),
              timezone: isTimeZone(user.timezone) ? user.timezone : "UTC",
            },
          }),
          // Every user gets a personal workspace, so tenant-scoped features work from
          // the first sign-in, for solo users and teams alike.
          after: async (user) => {
            await db.organization.create({
              data: {
                name: user.name,
                slug: `personal-${user.id}`,
                metadata: JSON.stringify({ personal: true }),
                members: { create: { userId: user.id, role: "owner" } },
              },
            });
          },
        },
      },
      session: {
        create: {
          // New sessions start in the user's first workspace (their personal one).
          before: async (session) => {
            if (session.activeOrganizationId) return { data: session };
            const membership = await db.member.findFirst({
              where: { userId: session.userId },
              orderBy: { createdAt: "asc" },
              select: { organizationId: true },
            });
            return {
              data: { ...session, activeOrganizationId: membership?.organizationId ?? null },
            };
          },
        },
      },
    },

    plugins: [
      emailOTP({
        otpLength: OTP_LENGTH,
        expiresIn: OTP_EXPIRES_IN,
        overrideDefaultEmailVerification: true,
        sendVerificationOnSignUp: true,
        // Only a hash is stored, so a database leak exposes no live codes.
        storeOTP: "hashed",
        sendVerificationOTP: async ({ email, otp, type }, ctx) => {
          await notifications.add(
            "send",
            {
              template: "auth.otp",
              to: { email, locale: await localeFor(email, ctx?.headers) },
              data: { otp, purpose: type, expiresInMinutes: Math.round(OTP_EXPIRES_IN / MINUTE) },
            },
            { jobId: randomUUID(), meta: jobMeta() },
          );
        },
      }),
      twoFactor({ issuer: "Boilerplate", backupCodeOptions: { amount: 10 } }),
      passkey({ rpID: webOrigin.hostname, rpName: "Boilerplate", origin: env.WEB_URL }),
      // Rejects passwords found in public breaches (k-anonymity: only a hash prefix is sent).
      haveIBeenPwned(),
      organization({
        creatorRole: "owner",
        invitationExpiresIn: INVITATION_DAYS * DAY,
        sendInvitationEmail: async ({ id, email, organization: org, inviter }, request) => {
          await notifications.add(
            "send",
            {
              template: "org.invitation",
              to: { email, locale: await localeFor(email, request?.headers) },
              data: {
                organizationName: org.name,
                inviterName: inviter.user.name,
                acceptUrl: new URL(`/invitations/${id}`, env.WEB_URL).toString(),
                expiresInDays: INVITATION_DAYS,
              },
            },
            { jobId: randomUUID(), meta: jobMeta() },
          );
        },
      }),
      admin({ impersonationSessionDuration: 60 * MINUTE }),
      // API keys for third-party REST access; hashed at rest, rate limited per key.
      apiKey({ defaultPrefix: "bp_", enableMetadata: true }),
      ...(env.TURNSTILE_SECRET_KEY
        ? [
            captcha({
              provider: "cloudflare-turnstile",
              secretKey: env.TURNSTILE_SECRET_KEY,
              endpoints: [
                "/sign-up/email",
                "/email-otp/send-verification-otp",
                "/email-otp/request-password-reset",
              ],
            }),
          ]
        : []),
    ],
  } satisfies BetterAuthOptions;

  return betterAuth(options);
}

export type Auth = ReturnType<typeof createAuth>;
export type Session = Auth["$Infer"]["Session"];

function isTimeZone(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
