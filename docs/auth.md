# Auth

Authentication is better-auth, configured in one place: `apps/api/src/auth/auth.ts`. It
is served under `/api/auth/*` on the site's own origin (the gateway, or the web app's
rewrites locally, route it to apps/api), so session cookies are first-party. Web and
mobile use the better-auth client from `packages/client/src/auth/client.ts`; oRPC
procedures read the session through the pipeline in `apps/api/src/rpc/procedures.ts`.

Auth never sends email itself: codes, invitations and alerts are queued on
`notifications-critical`, so a slow provider can't slow down or fail a sign-in.

## Sign-in methods

| Method | Web | Mobile | Notes |
|---|---|---|---|
| Email and password | yes | yes | 8 to 128 characters. Passwords found in public breaches are refused (Have I Been Pwned, k-anonymity). No session until the email is verified. |
| Emailed codes | yes | yes | 6 digits, 5 minutes, stored hashed. They verify the address after sign-up (and sign the user in), reset a forgotten password, and change the email (a code from the current and one from the new address). Signing in unverified sends a fresh code. |
| Passkeys | yes | no | WebAuthn, relying party = the `WEB_URL` host. |
| Google | yes | yes | On when `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set. Google accounts link to an existing account with the same verified email; OAuth tokens are encrypted at rest. |
| Two-factor (TOTP) | yes | yes | A second step after the password, with 10 backup codes and an option to trust the device. |

Phone numbers are not a sign-in method. A user can add one (verified by a texted code,
`apps/api/src/modules/user/phone.service.ts`) to receive security alerts by text.

better-auth's admin plugin is on (impersonation sessions last an hour); no admin UI
ships with it.

## Sessions

- Server-side and revocable: each session is in Redis (read on every request) with a
  durable copy in Postgres (the device list, audit). There is no cookie cache, so
  signing out or revoking a session rejects the same cookie on the next request.
- 7 days, extended at most once a day while in use.
- A password reset signs out every device.
- "Sudo mode": listing devices, adding a passkey and unlinking a social account need a
  session younger than `FRESH_SESSION_AGE` (2 hours, `packages/contracts/src/auth.ts`);
  after that the web app asks the user to sign in again. API procedures get the same
  rule from the `fresh` builder (`FRESH_SESSION_REQUIRED`). Password, 2FA and account
  deletion always ask for the password.
- The mobile app uses better-auth's Expo plugin: the session lives in the device's secure
  storage and travels in a header; its `boilerplate://` scheme is a trusted origin.
  Social sign-in goes through the plugin's `/expo-authorization-proxy` redirect, which
  only sends people to a provider's sign-in page (`PROVIDER_ORIGINS` in `auth.ts`; add a
  provider's origin there along with the provider).
- `trustedOrigins` (CSRF) are `WEB_URL`, `APP_ORIGINS` and the mobile scheme.

## Organizations and roles

Every user gets a personal workspace at sign-up, so organization-scoped features work
from the first sign-in, and new sessions start in the user's first workspace. Users can
create more and invite others (invitations last 7 days; the plan's member limit counts
pending invitations).

| Role | Can |
|---|---|
| `owner` | everything, including deleting the organization |
| `admin` | manage members, settings, API keys, webhooks, billing, the audit log |
| `member` | use the workspace |

Permissions are better-auth's organization defaults plus API key management for owners
and admins (`apps/api/src/auth/org-access.ts`). In the API:

| Builder | Lets through |
|---|---|
| `base` | anyone (and refuses clients older than `MINIMUM_CLIENT_VERSION`) |
| `authed` | a valid session |
| `fresh` | a session signed in within `FRESH_SESSION_AGE` |
| `inOrg` | a member of the session's active organization, or an API key with the procedure's scope; sets `context.orgId` for row-level security |
| `orgAdmin` | `inOrg` with role owner or admin |

Membership is re-checked on every organization-scoped request (cached in Redis for five
minutes, `apps/api/src/auth/memberships.ts`), and every membership change clears the
cache, so a removed member loses access on their next request. Deleting an account
deletes the workspaces only that user belongs to; a shared workspace without another
owner blocks deletion (`ORGANIZATION_NEEDS_OWNER`).

## API keys

Workspace keys for scripts and integrations calling the REST API (`/api/v1`), created
and revoked by owners and admins on the settings page. better-auth's api-key plugin
stores them (hashed, prefixed `bp_`), but its own endpoints are off: keys are managed
through the API's procedures (`apps/api/src/modules/api-keys`), which are typed and
audited (`org.api_key_created.v1`, `org.api_key_revoked.v1`).

- The key travels in `x-api-key` and acts as the admin who created it, with their current
  role, only in its workspace. It stops working when revoked, expired or when its creator
  leaves.
- A key outlives the session that made it, so creating one needs a recent sign-in (like
  account changes: `FRESH_SESSION_REQUIRED` two hours after signing in), every key expires (at most
  365 days; `expiresInDays: null` from older clients means the longest), and the
  workspace's owners and admins get an email when one is created. Adding a webhook
  endpoint or changing its URL follows the same rules. A password reset leaves keys
  alone: legitimate integrations would break on every reset, and the creation email is
  what tells owners to revoke one they don't recognise.
- It may only call procedures whose contract names a scope it has:

  ```ts
  list: base.meta({ apiKeyScope: "todos:read" }).route({ method: "GET", path: "/todos" })...
  ```

  Scopes are in `packages/contracts/src/api/scopes.ts`: `todos:read`, `todos:write`,
  `documents:read`, `documents:write`, `audit:read`. A procedure without one is for
  signed-in people only, so a key never reaches account settings, billing or key
  management.
- Up to 50 keys per workspace, 600 requests a minute per key, expiring after 30, 90 or 365
  days, or never.
- The per-key limit is better-auth's: it counts in the key's own row, so every call
  with a key writes to `auth.api_key`. That's fine at this limit; at high key traffic it
  becomes write load on Postgres, and the counter would move to Redis.

## OAuth for MCP clients

The API is an OAuth 2.1 authorization server (better-auth's `mcp` and `jwt` plugins) for
MCP clients such as Claude or an IDE, with two protected MCP servers on the site's
origin:

| Server | Resource | Tools | Scopes |
|---|---|---|---|
| apps/api | `<site>/api/mcp` | `list_todos`, `add_todo`, `set_todo_completed`, `delete_todo` | `todos:read`, `todos:write` |
| apps/ai | `<site>/ai/mcp` | `list_documents`, `search_documents` | `documents:read` |

- Clients register themselves: by URL (Client ID Metadata Documents, fetched without
  following redirects or reaching private addresses) or with RFC 7591 dynamic
  registration, limited to 5 a minute per address.
- Signed-out users sign in through the normal pages, then approve on `/oauth/consent`,
  where they also pick the workspace. Each workspace is approved separately and travels
  in the token's `org` claim.
- Access tokens are JWTs, audience-bound to one server, valid for 15 minutes and signed
  with keys published at `/api/auth/jwks` (rotated every 90 days, old keys kept 30 days).
  Refresh tokens rotate. The JWT plugin's `/token` endpoint is off, so sessions can't be
  swapped for JWTs.
- Both servers verify tokens themselves and call `auth.mcp_grant_active` on every
  request, so disconnecting an app in settings (Security, connected apps) or leaving the
  workspace takes effect immediately. Tool calls are limited to 60 a minute per app and
  user.
- Discovery: `/.well-known/oauth-authorization-server/api/auth`,
  `/.well-known/openid-configuration/api/auth` and
  `/.well-known/oauth-protected-resource/{api,ai}/mcp`.

To add a tool, see the header of `apps/api/src/mcp/mcp.server.ts` or
[python-services.md](python-services.md).

## Secrets at rest

better-auth encrypts what it stores that would let someone act as a user: OAuth tokens
from Google, two-factor secrets and backup codes, and the private keys that sign OAuth
and MCP tokens. The key is `BETTER_AUTH_SECRET`; rotating it means adding versioned
secrets (`BETTER_AUTH_SECRETS`, `apps/api/src/auth/secrets.ts`) and then running
`bun run secrets:reencrypt`, which moves every stored value, and the webhook signing
secrets under `ENCRYPTION_KEYS`, to the newest key (`apps/api/src/secrets/reencrypt.ts`).
The rotate-secrets runbook (`.claude/skills/rotate-secrets/SKILL.md`) has the steps.

## Security alerts

Every sensitive account change emails the account's address and texts its verified
phone, and is recorded in the audit log (`apps/api/src/auth/security-alerts.ts`): email
changed (to the old address), password changed or reset, two-factor enabled or disabled,
passkey added, phone added or removed (to the previous number too), and an app
connected. The alert is sent from an after-hook only when the request succeeded, and
never fails it.

## Rate limits

better-auth limits every auth endpoint to 100 requests a minute per client IP, stored in
Redis, with tighter rules on the endpoints that guess secrets:

| Endpoint | Limit |
|---|---|
| `/sign-in/email`, `/sign-up/email`, `/email-otp/*`, `/two-factor/*` | 5 a minute |
| `/forget-password/*` | 3 a minute |
| `/oauth2/register` | 5 a minute |

Emails to an address someone else typed are limited where they're sent, whichever
endpoint asked: ten codes an hour per address (past that the code is dropped; better-auth
answers the same either way, so nobody learns which addresses have accounts), and
invitations to three a day per address and thirty an hour per inviter (refused with
429). An account belongs to at most 20 workspaces, and a workspace has at most 20
invitations waiting (`ORGANIZATION_LIMIT`, `PENDING_INVITATION_LIMIT` in
`packages/contracts/src/auth-settings.ts`). The invitation's subject names neither the
workspace nor the inviter, which someone else chose; the body quotes both.

An address can be rotated, so the endpoints that guess or send secrets are also limited
per account (`apps/api/src/auth/account-limits.ts`), whatever address the attempts come
from: 10 password sign-ins, reset-password or verify-email attempts and 10 second-factor
checks per 15 minutes, and 5 codes sent. They're keyed on the normalised email, or for a
second factor on the sign-in attempt's two-factor cookie, and refuse the attempt when
Redis is down. The cost: someone can spend an account's attempts and lock it out of
these endpoints for the window; a passkey or an existing session still works.

Elsewhere, `createRateLimiter` (`packages/nest-common/src/rate-limit.ts`) limits
assistant questions (20 a minute), AI documents and file uploads (30 an hour), phone
codes (5 an hour per user, 3 per number, refused when Redis is down), MCP tool calls and
API keys, all shared across replicas through Redis.

Phone codes can go to any country: there's no list of allowed country codes. Texts to
some destinations cost far more than others, and SMS pumping targets exactly those, so a
product that sends texts should add an allowlist (in `PhoneService`, before the code is
sent) for the countries it serves.

The client IP comes from `X-Forwarded-For` only when the peer is in `TRUSTED_PROXIES`;
the API overwrites the header better-auth sees with that resolved address, so a client
can't forge the IP limits are keyed on. That holds because only Cloudflare can reach the
site's hosts (the gateway requires its origin-pull certificate; see
`infra/tofu/README.md`), so the rightmost address the gateway trusts is the one
Cloudflare saw.

## Captcha

With `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` set, Cloudflare Turnstile guards
sign-up, sending a verification code and requesting a password reset. Clients get the
site key from `system.info` and render the widget (`apps/web/src/components/captcha.tsx`).

## Changing the auth setup

After adding or removing a better-auth plugin, `bun run --filter @repo/api auth:schema`
prints the tables the current plugin set expects (to
`node_modules/.cache/auth-schema.prisma`); port the differences into
`packages/db/prisma/schema/auth.prisma` with this repo's conventions and write a
migration ([database.md](database.md)).
