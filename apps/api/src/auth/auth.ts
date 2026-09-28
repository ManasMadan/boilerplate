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
  userAdditionalFields,
} from "@repo/contracts/auth";
import type { Db } from "@repo/db";
import { isLocale, type Locale, negotiateLocale } from "@repo/i18n";
import type { JobMeta, Producer } from "@repo/jobs";
import { currentContext } from "@repo/nest-common";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError, createAuthMiddleware, isAPIError } from "better-auth/api";
import { captcha } from "better-auth/plugins";
import { admin } from "better-auth/plugins/admin";
import { emailOTP } from "better-auth/plugins/email-otp";
import { haveIBeenPwned } from "better-auth/plugins/haveibeenpwned";
import { organization } from "better-auth/plugins/organization";
import { twoFactor } from "better-auth/plugins/two-factor";
import type { Redis } from "ioredis";
import type { Env } from "../env";
import { features } from "../features";
import { securityAlertFor } from "./security-alerts";

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
      // locale + timezone: captured from the browser at sign-up and normalised in
      // databaseHooks below. Shared with clients so they're typed there too.
      additionalFields: userAdditionalFields,
      deleteUser: {
        enabled: true,
        // Workspaces only this user belongs to are deleted with the account, and their
        // data with them (tenant tables cascade from auth.organization). A shared
        // workspace would be left without an owner, so that blocks deletion until
        // ownership is handed over.
        beforeDelete: async (user) => {
          const owned = await db.member.findMany({
            where: { userId: user.id, role: "owner" },
            select: {
              organizationId: true,
              organization: { select: { members: { select: { userId: true, role: true } } } },
            },
          });
          const soleMember: string[] = [];
          for (const { organizationId, organization } of owned) {
            const others = organization.members.filter((member) => member.userId !== user.id);
            if (others.length === 0) soleMember.push(organizationId);
            else if (!others.some((member) => member.role === "owner")) {
              throw new APIError("BAD_REQUEST", {
                code: "ORGANIZATION_NEEDS_OWNER",
                message:
                  "Transfer ownership of your shared workspaces before deleting your account.",
              });
            }
          }
          await db.organization.deleteMany({ where: { id: { in: soleMember } } });
        },
      },
      // Email changes go only through the code-based flow in emailOTP below; the
      // link-based /change-email endpoint stays off so there's one audited path.
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

    // Security alerts: every sensitive change is emailed to the account's address, so a
    // takeover (or a mistake) never goes unnoticed. Runs after the endpoint, only when
    // it succeeded, and never fails the request: the email is queued with retries.
    hooks: {
      after: createAuthMiddleware(async (ctx) => {
        if (isAPIError(ctx.context.returned)) return;
        const alert = securityAlertFor(ctx);
        if (!alert) return;
        await notifications.add(
          "send",
          {
            template: "auth.security-alert",
            to: { email: alert.email, locale: await localeFor(alert.email, ctx.headers) },
            data: {
              event: alert.event,
              ...(alert.newEmail && { newEmail: alert.newEmail }),
              securityUrl: new URL("/settings/security", env.WEB_URL).toString(),
            },
          },
          { jobId: randomUUID(), meta: jobMeta() },
        );
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
        // Profile edits go through the same rules: an unknown language or zone is refused
        // rather than stored, so emails and dates never render with garbage settings.
        update: {
          before: async (user) => {
            if (
              (user.locale !== undefined && !isLocale(user.locale)) ||
              (user.timezone !== undefined && !isTimeZone(user.timezone))
            ) {
              // Returning false would skip the write but still report success.
              throw new APIError("BAD_REQUEST", { code: "VALIDATION_FAILED" });
            }
            return {
              data: {
                ...user,
                ...(typeof user.name === "string" && {
                  name: user.name.trim().slice(0, NAME_MAX_LENGTH),
                }),
              },
            };
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
        // Changing the email needs a code from the current address and one from the new
        // address, so a hijacked session alone can't move the account elsewhere.
        changeEmail: { enabled: true, verifyCurrentEmail: true },
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
