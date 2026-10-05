/**
 * The better-auth plugins whose configuration is more than a line (auth.ts lists them
 * all): emailed codes, organizations, API keys, the MCP authorization server and the
 * captcha.
 */
import { randomUUID } from "node:crypto";
import { apiKey } from "@better-auth/api-key";
import { mcp } from "@better-auth/mcp";
import {
  API_KEY_EXPIRY_DAYS,
  API_KEY_NAME_MAX_LENGTH,
  API_KEY_PREFIX,
  API_KEY_REQUESTS_PER_MINUTE,
} from "@repo/contracts/api";
import {
  ORGANIZATION_LIMIT,
  OTP_EXPIRES_IN,
  OTP_LENGTH,
  PENDING_INVITATION_LIMIT,
} from "@repo/contracts/auth";
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
import { DAY_S, MINUTE_MS, MINUTE_S } from "@repo/contracts/time";
import { jobMetaFromContext } from "@repo/nest-common";
import { APIError } from "better-auth/api";
import { captcha } from "better-auth/plugins";
import { emailOTP } from "better-auth/plugins/email-otp";
import { type OrganizationOptions, organization } from "better-auth/plugins/organization";
import type { Env } from "../env";
import { features } from "../features";
import { type AuthContext } from "./auth-context";
import { orgAccess, orgRoles } from "./org-access";

const INVITATION_DAYS = 7;

/** Refuses a client's attempt to mark a workspace as someone's personal one. */
function refusePersonal(org: { slug?: string; metadata?: Record<string, unknown> }) {
  if (org.slug?.startsWith("personal-") || (org.metadata && "personal" in org.metadata)) {
    throw new APIError("BAD_REQUEST", { code: "VALIDATION_FAILED" });
  }
}

/** Sign-in, verification and email-change codes, sent through the notification service. */
export function emailOtpPlugin({ emailLimits, notifications, localeFor }: AuthContext) {
  return emailOTP({
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
      // better-auth sends codes in the background and answers the same either way (so
      // nobody learns which addresses have accounts): past the limit the code is dropped,
      // and better-auth logs why.
      await emailLimits.code(email);
      await notifications.add(
        "send",
        {
          template: "auth.otp",
          to: { email, locale: await localeFor(email, ctx?.headers) },
          data: { otp, purpose: type, expiresInMinutes: Math.round(OTP_EXPIRES_IN / MINUTE_S) },
        },
        { jobId: randomUUID(), meta: jobMetaFromContext() },
      );
    },
  });
}

/** Membership changes, audited and forgetting the cached role. */
function membershipHooks({
  memberships,
  record,
  actor,
  memberRemoved,
}: AuthContext): NonNullable<OrganizationOptions["organizationHooks"]> {
  return {
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
      await memberRemoved({ ...member, organizationId: org.id }, actor(member.userId));
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
  };
}

/** Workspaces created, deleted and invited to: audited, and held to the plan's limits. */
function workspaceHooks({
  db,
  billing,
  memberships,
  record,
}: AuthContext): NonNullable<OrganizationOptions["organizationHooks"]> {
  return {
    // Only the sign-up hook makes the personal workspace (slug personal-<user id>,
    // metadata.personal); a client claiming either could pass any workspace off as
    // someone's own, on the consent page too.
    beforeCreateOrganization: async ({ organization: org }) => refusePersonal(org),
    beforeUpdateOrganization: async ({ organization: org }) => refusePersonal(org),
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
  };
}

export function organizationPlugin(context: AuthContext) {
  const { env, billing, notifications, localeFor } = context;
  return organization({
    creatorRole: "owner",
    ac: orgAccess,
    roles: orgRoles,
    invitationExpiresIn: INVITATION_DAYS * DAY_S,
    organizationLimit: ORGANIZATION_LIMIT,
    invitationLimit: PENDING_INVITATION_LIMIT,
    // The plan's member limit (packages/contracts billing); null means none.
    membershipLimit: async (_user, org) =>
      (await billing.entitlements(org.id)).members ?? Number.MAX_SAFE_INTEGER,
    // Every membership change is audited (in the organization's own log, so its admins
    // see it) and forgets the cached role, so access follows immediately.
    organizationHooks: { ...workspaceHooks(context), ...membershipHooks(context) },
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
        { jobId: randomUUID(), meta: jobMetaFromContext() },
      );
    },
  });
}

/**
 * Workspace API keys for the REST API (see modules/api-keys): hashed at rest, owned by the
 * organization, rate limited per key, and never a session of their own.
 */
export function apiKeyPlugin() {
  return apiKey({
    references: "organization",
    defaultPrefix: API_KEY_PREFIX,
    requireName: true,
    maximumNameLength: API_KEY_NAME_MAX_LENGTH,
    enableMetadata: true,
    keyExpiration: { maxExpiresIn: Math.max(...API_KEY_EXPIRY_DAYS) },
    rateLimit: {
      enabled: true,
      timeWindow: MINUTE_MS,
      maxRequests: API_KEY_REQUESTS_PER_MINUTE,
    },
  });
}

/** The scopes each MCP server accepts tokens for: only the ones its tools use. */
const mcpResources = (baseUrl: string) => [
  {
    identifier: mcpResource(baseUrl, MCP_PATH),
    allowedScopes: [...MCP_SERVER_SCOPES[MCP_PATH]],
  },
  {
    identifier: mcpResource(baseUrl, AI_MCP_PATH),
    allowedScopes: [...MCP_SERVER_SCOPES[AI_MCP_PATH]],
  },
];

/**
 * The OAuth 2.1 authorization server for MCP clients (Claude, IDEs, agents). Signed-out
 * users sign in through the normal pages (every step keeps the signed OAuth request in its
 * URL), then approve on /oauth/consent, where they also pick the workspace the client may
 * act in. That workspace is the consent's reference, so each workspace is approved
 * separately, and it travels in the token's `org` claim. Tokens are audience-bound to one
 * MCP server and last 15 minutes; refresh tokens rotate, and deleting the connection
 * (settings) revokes them.
 */
export function mcpPlugin({ env, memberships }: AuthContext) {
  return mcp({
    loginPage: "/sign-in",
    consentPage: "/oauth/consent",
    resource: mcpResource(env.BETTER_AUTH_URL, MCP_PATH),
    scopes: [...IDENTITY_SCOPES, ...MCP_SCOPES],
    resources: mcpResources(env.BETTER_AUTH_URL),
    // Clients that register themselves may use both servers.
    clientRegistrationDefaultResources: [mcpResource(env.BETTER_AUTH_URL, AI_MCP_PATH)],
    // The resource policy above is the source of truth on every boot.
    resourceSeedMode: "overwrite",
    accessTokenExpiresIn: MCP_ACCESS_TOKEN_SECONDS,
    // MCP clients register themselves: by URL (Client ID Metadata Documents, auth.ts) or,
    // for clients that don't publish one, with RFC 7591 registration.
    allowDynamicClientRegistration: true,
    allowUnauthenticatedClientRegistration: true,
    postLogin: {
      page: "/oauth/consent",
      // The workspace is chosen on the consent page itself (it becomes the active one),
      // so there is no separate step after sign-in.
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
  });
}

/** Turnstile on the forms that create accounts or send codes, when it's configured. */
export function captchaPlugins(env: Env) {
  if (!features.captcha || !env.TURNSTILE_SECRET_KEY) return [];
  return [
    captcha({
      provider: "cloudflare-turnstile",
      secretKey: env.TURNSTILE_SECRET_KEY,
      endpoints: [
        "/sign-up/email",
        "/email-otp/send-verification-otp",
        "/email-otp/request-password-reset",
      ],
    }),
  ];
}
