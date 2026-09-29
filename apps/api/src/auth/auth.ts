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
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { mcp } from "@better-auth/mcp";
import { passkey } from "@better-auth/passkey";
import { redisStorage } from "@better-auth/redis-storage";
import {
  FRESH_SESSION_AGE,
  NAME_MAX_LENGTH,
  OTP_EXPIRES_IN,
  OTP_LENGTH,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  userAdditionalFields,
} from "@repo/contracts/auth";
import type { Entitlements } from "@repo/contracts/billing";
import type { EventName, EventPayload } from "@repo/contracts/events";
import {
  AI_MCP_PATH,
  IDENTITY_SCOPES,
  MCP_ACCESS_TOKEN_SECONDS,
  MCP_PATH,
  MCP_SCOPES,
  MCP_SERVER_SCOPES,
  mcpResource,
  ORG_CLAIM,
} from "@repo/contracts/mcp";
import { type Db, transaction } from "@repo/db";
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
import { jwt } from "better-auth/plugins/jwt";
import { organization } from "better-auth/plugins/organization";
import { twoFactor } from "better-auth/plugins/two-factor";
import type { Redis } from "ioredis";
import type { Env } from "../env";
import { features } from "../features";
import { type EventOrigin, emitAnyEvent, emitEvent } from "../outbox";
import { auditEventForAlert, sessionEndReason, sessionMethod } from "./auth-events";
import type { Memberships } from "./memberships";
import { securityAlertFor } from "./security-alerts";

export interface AuthDependencies {
  env: Env;
  db: Db;
  redis: Redis;
  notifications: Producer<"notifications-critical">;
  memberships: Memberships;
  /** Plan limits and cancelling a deleted organization's subscription (modules/billing). */
  billing: {
    entitlements(orgId: string): Promise<Entitlements>;
    cancelFor(orgId: string): Promise<void>;
  };
  /** Where better-auth stores its rows; Postgres through Prisma unless given (auth.cli.ts). */
  database?: BetterAuthOptions["database"];
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

export function createAuth({
  env,
  db,
  redis,
  notifications,
  memberships,
  billing,
  database = prismaAdapter(db, { provider: "postgresql" }),
}: AuthDependencies) {
  const webOrigin = new URL(env.WEB_URL);

  /** Records an audit event for auth activity (see auth-events.ts for why it's separate). */
  function record<N extends EventName>(
    name: N,
    key: string,
    payload: EventPayload<N>,
    origin: EventOrigin,
  ) {
    return transaction(db, (tx) => emitEvent(tx, name, key, payload, origin));
  }
  /** The signed-in user performing an auth action, when there is one. */
  const actor = (fallback: string) => currentContext()?.userId ?? fallback;

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
    // The JWT plugin's /token would hand any session a signed JWT; access tokens come
    // only from the OAuth flow below.
    disabledPaths: ["/token"],

    database,
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
      // "Sudo mode": listing devices, adding a passkey and unlinking a social account
      // need a session signed in within this window (better-auth's fresh-session rule);
      // after it, the web app asks the user to sign in again. Password, 2FA and account
      // deletion always ask for the password, and email changes need emailed codes.
      freshAge: FRESH_SESSION_AGE,
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
        // Anyone may register an MCP client (it still needs a user's consent to get a
        // token), so registration is limited per address.
        "/oauth2/register": { window: MINUTE, max: 5 },
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
          // Nothing may keep charging for a workspace that's going away.
          for (const organizationId of soleMember) await billing.cancelFor(organizationId);
          await transaction(db, async (tx) => {
            await tx.organization.deleteMany({ where: { id: { in: soleMember } } });
            for (const organizationId of soleMember) {
              await emitEvent(
                tx,
                "org.deleted.v1",
                organizationId,
                { organizationId },
                { actorId: user.id, orgId: organizationId },
              );
            }
          });
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
        const account = await db.user.findUnique({
          where: ctx.context.session ? { id: ctx.context.session.user.id } : { email: alert.email },
          select: { id: true, phoneNumber: true },
        });
        const userId = account?.id;
        if (userId) {
          await transaction(db, (tx) =>
            emitAnyEvent(tx, auditEventForAlert(alert, userId), userId, {
              actorId: userId,
              orgId: null,
            }),
          );
        }
        await notifications.add(
          "send",
          {
            template: "auth.security-alert",
            to: {
              email: alert.email,
              locale: await localeFor(alert.email, ctx.headers),
              ...(account?.phoneNumber && { phone: account.phoneNumber }),
            },
            data: {
              event: alert.event,
              ...("newEmail" in alert && alert.newEmail && { newEmail: alert.newEmail }),
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
            await transaction(db, async (tx) => {
              const org = await tx.organization.create({
                data: {
                  name: user.name,
                  slug: `personal-${user.id}`,
                  metadata: JSON.stringify({ personal: true }),
                  members: { create: { userId: user.id, role: "owner" } },
                },
              });
              const origin = { actorId: user.id, orgId: org.id };
              await emitEvent(tx, "auth.signed_up.v1", user.id, { userId: user.id }, origin);
              await emitEvent(
                tx,
                "org.created.v1",
                org.id,
                { organizationId: org.id, name: org.name },
                origin,
              );
            });
          },
        },
        delete: {
          after: async (user) => {
            await record(
              "auth.account_deleted.v1",
              user.id,
              { userId: user.id },
              { actorId: user.id, orgId: null },
            );
          },
        },
        // Profile edits go through the same rules: an unknown language or zone is refused
        // rather than stored, so emails and dates never render with garbage settings.
        update: {
          before: async (user, ctx) => {
            // The picture is set only by the avatar flow (a checked upload), never to a
            // URL a client picks.
            if (ctx?.path === "/update-user" && user.image !== undefined) {
              throw new APIError("BAD_REQUEST", { code: "VALIDATION_FAILED" });
            }
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
          after: async (session, ctx) => {
            await record(
              "auth.session_started.v1",
              session.id,
              { userId: session.userId, sessionId: session.id, method: sessionMethod(ctx?.path) },
              { actorId: session.userId, orgId: null },
            );
          },
        },
        delete: {
          after: async (session, ctx) => {
            await record(
              "auth.session_ended.v1",
              session.id,
              {
                userId: session.userId,
                sessionId: session.id,
                reason: sessionEndReason(ctx?.path),
              },
              { actorId: actor(session.userId), orgId: null },
            );
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
        // The plan's member limit (packages/contracts billing); null means none.
        membershipLimit: async (_user, org) =>
          (await billing.entitlements(org.id)).members ?? Number.MAX_SAFE_INTEGER,
        // Every membership change is audited (in the organization's own log, so its
        // admins see it) and forgets the cached role, so access follows immediately.
        organizationHooks: {
          afterCreateOrganization: async ({ organization: org, user }) => {
            await memberships.forget(org.id, user.id);
            await record(
              "org.created.v1",
              org.id,
              { organizationId: org.id, name: org.name },
              { actorId: user.id, orgId: org.id },
            );
          },
          beforeDeleteOrganization: async ({ organization: org }) => {
            await billing.cancelFor(org.id);
            await memberships.forgetOrganization(org.id);
          },
          // Invitations count towards the member limit, so a full plan can't over-invite.
          beforeCreateInvitation: async ({ organization: org }) => {
            const { members: limit } = await billing.entitlements(org.id);
            if (limit === null) return;
            const [members, pending] = await Promise.all([
              db.member.count({ where: { organizationId: org.id } }),
              db.invitation.count({ where: { organizationId: org.id, status: "pending" } }),
            ]);
            if (members + pending >= limit) {
              throw new APIError("FORBIDDEN", {
                code: "ENTITLEMENT_REQUIRED",
                message: "The plan's member limit is reached.",
              });
            }
          },
          afterDeleteOrganization: async ({ organization: org, user }) => {
            await record(
              "org.deleted.v1",
              org.id,
              { organizationId: org.id },
              { actorId: user.id, orgId: org.id },
            );
          },
          afterAddMember: async ({ member, organization: org }) => {
            await memberships.forget(org.id, member.userId);
            await record(
              "org.member_added.v1",
              member.id,
              { organizationId: org.id, userId: member.userId, role: member.role },
              { actorId: actor(member.userId), orgId: org.id },
            );
          },
          afterAcceptInvitation: async ({ member, organization: org }) => {
            await memberships.forget(org.id, member.userId);
            await record(
              "org.member_added.v1",
              member.id,
              { organizationId: org.id, userId: member.userId, role: member.role },
              { actorId: member.userId, orgId: org.id },
            );
          },
          afterRemoveMember: async ({ member, organization: org }) => {
            await memberships.forget(org.id, member.userId);
            await record(
              "org.member_removed.v1",
              member.id,
              { organizationId: org.id, userId: member.userId, role: member.role },
              { actorId: actor(member.userId), orgId: org.id },
            );
          },
          afterUpdateMemberRole: async ({ member, previousRole, organization: org }) => {
            await memberships.forget(org.id, member.userId);
            await record(
              "org.member_role_changed.v1",
              member.id,
              { organizationId: org.id, userId: member.userId, role: member.role, previousRole },
              { actorId: actor(member.userId), orgId: org.id },
            );
          },
          afterCreateInvitation: async ({ invitation, inviter, organization: org }) => {
            await record(
              "org.invitation_sent.v1",
              invitation.id,
              {
                organizationId: org.id,
                invitationId: invitation.id,
                email: invitation.email,
                role: String(invitation.role),
              },
              { actorId: inviter.id, orgId: org.id },
            );
          },
        },
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
      // Signing keys for OAuth access tokens, published at /api/auth/jwks so each MCP
      // server verifies tokens itself. Keys rotate; old ones stay published for the
      // grace period so tokens signed just before a rotation still verify.
      jwt({
        jwks: { rotationInterval: 90 * DAY, gracePeriod: 30 * DAY },
        // Sessions stay cookies; only the OAuth flow issues JWTs.
        disableSettingJwtHeader: true,
      }),
      // The OAuth 2.1 authorization server for MCP clients (Claude, IDEs, agents).
      // Signed-out users sign in through the normal pages (every step keeps the signed
      // OAuth request in its URL), then approve on /oauth/consent, where they also pick
      // the workspace the client may act in. That workspace is the consent's reference,
      // so each workspace is approved separately, and it travels in the token's `org`
      // claim. Tokens are audience-bound to one MCP server and last 15 minutes; refresh
      // tokens rotate, and deleting the connection (settings) revokes them.
      mcp({
        loginPage: "/sign-in",
        consentPage: "/oauth/consent",
        resource: mcpResource(env.BETTER_AUTH_URL, MCP_PATH),
        scopes: [...IDENTITY_SCOPES, ...MCP_SCOPES],
        // Each MCP server accepts tokens only for the scopes its tools use.
        resources: [
          {
            identifier: mcpResource(env.BETTER_AUTH_URL, MCP_PATH),
            allowedScopes: [...MCP_SERVER_SCOPES[MCP_PATH]],
          },
          {
            identifier: mcpResource(env.BETTER_AUTH_URL, AI_MCP_PATH),
            allowedScopes: [...MCP_SERVER_SCOPES[AI_MCP_PATH]],
          },
        ],
        // Clients that register themselves may use both servers.
        clientRegistrationDefaultResources: [mcpResource(env.BETTER_AUTH_URL, AI_MCP_PATH)],
        // The resource policy above is the source of truth on every boot.
        resourceSeedMode: "overwrite",
        accessTokenExpiresIn: MCP_ACCESS_TOKEN_SECONDS,
        // MCP clients register themselves: by URL (Client ID Metadata Documents, below)
        // or, for clients that don't publish one, with RFC 7591 registration.
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        postLogin: {
          page: "/oauth/consent",
          // The workspace is chosen on the consent page itself (it becomes the active
          // one), so there is no separate step after sign-in.
          shouldRedirect: () => false,
          consentReferenceId: ({ session }) => {
            const orgId = session?.activeOrganizationId;
            if (typeof orgId !== "string") {
              throw new APIError("BAD_REQUEST", { error: "invalid_request" });
            }
            return orgId;
          },
        },
        customAccessTokenClaims: async ({ user, referenceId }) => {
          // The consent named a workspace; it must still be one of the user's.
          if (!user || !referenceId || !(await memberships.role(referenceId, user.id))) {
            throw new APIError("FORBIDDEN", { error: "access_denied" });
          }
          return { [ORG_CLAIM]: referenceId };
        },
      }),
      // Client ID Metadata Documents (the MCP 2026-07-28 way): a client's id is a URL to
      // its metadata, fetched through a transport that resolves DNS once, refuses private
      // addresses and never follows redirects (no SSRF).
      cimd({ fetchClientMetadataResource, metadataProfile: "mcp-2026-07-28" }),
      ...(features.captcha && env.TURNSTILE_SECRET_KEY
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
