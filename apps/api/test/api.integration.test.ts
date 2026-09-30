/**
 * The API's security and behaviour guarantees, against the real app, database and Redis.
 */
import { randomUUID } from "node:crypto";
import http from "node:http";
import { ORPCError } from "@orpc/client";
import { WEBHOOK_SECRET_OVERLAP_HOURS } from "@repo/contracts/api";
import { ORGANIZATION_LIMIT, PENDING_INVITATION_LIMIT } from "@repo/contracts/auth";
import { realtimeChannel } from "@repo/contracts/realtime";
import { queuePrefix } from "@repo/jobs";
import { createSignedTokens, S3Storage } from "@repo/nest-common";
import { totp } from "@repo/testing/totp";
import { Queue } from "bullmq";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { publishRealtime } from "../src/realtime";
import {
  createSession,
  editSession,
  expireOtps,
  type Harness,
  LOCAL_STORAGE,
  newEmail,
  newPassword,
  startApi,
  takeNotification,
  takeOtp,
} from "./harness";

let harness: Harness;

beforeAll(async () => {
  harness = await startApi(13, {
    MINIMUM_CLIENT_VERSION: "2.0.0",
    // The test receiver below runs on loopback.
    WEBHOOK_ALLOWED_PRIVATE_ADDRESSES: "127.0.0.1",
    VAPID_PUBLIC_KEY: "BPublicVapidKeyForTests",
    ...LOCAL_STORAGE,
  });
});
afterAll(() => harness?.close());

/** Signs up and verifies a new user; returns their session. */
async function signedInUser(locale = "en") {
  const session = createSession(harness, { locale });
  const email = newEmail();
  const password = newPassword();
  await session.auth("/sign-up/email", { email, password, name: "Test User" });
  const { otp } = await takeOtp(harness, email);
  await session.auth("/email-otp/verify-email", { email, otp });
  return { session, email, password };
}

async function expectError(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error, `expected ${code}`).toBeInstanceOf(ORPCError);
  const orpcError = error as ORPCError<string, { issues?: unknown; params?: unknown }>;
  expect(orpcError.code).toBe(code);
  return orpcError;
}

describe("request bodies", () => {
  const post = (path: string, type: string, body: BodyInit) =>
    fetch(`${harness.baseUrl}${path}`, { method: "POST", headers: { "content-type": type }, body });

  /**
   * The status for a request announcing a body of `bytes`: sends only the headers and
   * waits, so a refusal by length alone shows (nothing is read or parsed).
   */
  function statusFor(path: string, bytes: number, type = "application/json") {
    return new Promise<number>((resolve, reject) => {
      const request = http.request(`${harness.baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": type, "content-length": bytes },
      });
      request.on("response", (response) => {
        resolve(response.statusCode ?? 0);
        request.destroy();
      });
      request.on("error", reject);
      request.flushHeaders();
    });
  }

  it("refuses an oversized body before any procedure or auth check runs", async () => {
    const big = 2 * 1024 * 1024;
    expect(await statusFor("/rpc/todo/create", big)).toBe(413);
    expect(await statusFor("/api/v1/todos", big)).toBe(413);
    // 100 MB of text, unauthenticated: refused from the headers, never read.
    expect(await statusFor("/rpc/todo/create", 100 * 1024 * 1024, "text/plain")).toBe(415);
  });

  it("accepts only JSON on the API routes", async () => {
    for (const type of [
      "text/plain",
      "application/octet-stream",
      "multipart/form-data; boundary=x",
    ]) {
      expect((await post("/rpc/todo/create", type, "x".repeat(1024))).status, type).toBe(415);
      expect((await post("/api/v1/todos", type, "x".repeat(1024))).status, type).toBe(415);
    }
  });

  it("still serves JSON calls", async () => {
    const response = await post(
      "/rpc/todo/list",
      "application/json",
      JSON.stringify({ json: { limit: 1 } }),
    );
    // Unauthenticated, but parsed and routed: the procedure answered.
    expect(response.status).toBe(401);
  });
});

describe("the mobile sign-in redirect", () => {
  const proxy = (target: string) =>
    fetch(
      `${harness.baseUrl}/api/auth/expo-authorization-proxy?${new URLSearchParams({ authorizationURL: target })}`,
      { redirect: "manual" },
    );

  it("sends people only to a sign-in provider", async () => {
    const google = await proxy("https://accounts.google.com/o/oauth2/v2/auth?state=abc");
    expect(google.status).toBe(302);
    expect(google.headers.get("location")).toMatch(/^https:\/\/accounts\.google\.com\//);
  });

  it("refuses any other address", async () => {
    for (const target of [
      "https://evil.example/login?state=abc",
      "https://accounts.google.com.evil.example/?state=abc",
      "not a url",
    ]) {
      const response = await proxy(target);
      expect(response.status, target).toBe(400);
      expect(response.headers.get("location")).toBeNull();
    }
  });
});

describe("sign-up and verification", () => {
  it("sends one address at most ten codes an hour, whichever endpoint asks", async () => {
    const session = createSession(harness);
    const email = newEmail();
    const password = newPassword();
    await session.auth("/sign-up/email", { email, password, name: "Codes" });
    // Eleven requests for a code, within each endpoint's per-address limit: the sign-up,
    // three resets, five verification codes and two sign-ins to the unverified account.
    for (let i = 0; i < 3; i++) await session.auth("/forget-password/email-otp", { email });
    for (let i = 0; i < 5; i++) {
      await session.auth("/email-otp/send-verification-otp", { email, type: "email-verification" });
    }
    for (let i = 0; i < 2; i++) await session.auth("/sign-in/email", { email, password });
    for (let i = 0; i < 10; i++) await takeOtp(harness, email);
    await expect(takeOtp(harness, email)).rejects.toThrow(/No auth.otp queued/);
  });

  it("issues no session until the email is verified, and queues the code in the browser's language", async () => {
    const session = createSession(harness, { locale: "es-ES,es;q=0.9" });
    const email = newEmail();
    const signUp = await session.auth<{ token: string | null }>("/sign-up/email", {
      email,
      password: newPassword(),
      name: "Lucía",
    });
    expect(signUp.status).toBe(200);
    expect(signUp.body.token).toBeNull();
    await expectError(session.rpc.user.me(), "UNAUTHENTICATED");

    const code = await takeOtp(harness, email);
    expect(code).toMatchObject({ locale: "es", purpose: "email-verification" });
    expect(code.otp).toMatch(/^\d{6}$/);

    await session.auth("/email-otp/verify-email", { email, otp: code.otp });
    const me = await session.rpc.user.me();
    expect(me).toMatchObject({ email, locale: "es" });
    expect(me.activeOrganizationId).toBeTruthy();
  });

  it("rejects passwords found in public breaches", async () => {
    const session = createSession(harness);
    const result = await session.auth<{ code: string }>("/sign-up/email", {
      email: newEmail(),
      password: "password123",
      name: "X",
    });
    expect(result.body.code).toBe("PASSWORD_COMPROMISED");
  });
});

describe("session revocation", () => {
  it("rejects a signed-out session's cookie on the very next request", async () => {
    const { session } = await signedInUser();
    const stolen = session.cookies();
    await session.auth("/sign-out");

    const attacker = createSession(harness);
    attacker.useCookies(stolen);
    await expectError(attacker.rpc.user.me(), "UNAUTHENTICATED");
  });

  it("kills other sessions when a device is revoked", async () => {
    const { session: laptop, email, password } = await signedInUser();
    const phone = createSession(harness);
    await phone.auth("/sign-in/email", { email, password });
    await expect(phone.rpc.user.me()).resolves.toMatchObject({ email });

    await laptop.auth("/revoke-other-sessions");
    await expectError(phone.rpc.user.me(), "UNAUTHENTICATED");
    await expect(laptop.rpc.user.me()).resolves.toMatchObject({ email });
  });

  it("signs out every device when the password is reset", async () => {
    const { session, email } = await signedInUser();
    const anonymous = createSession(harness);
    await anonymous.auth("/email-otp/request-password-reset", { email });
    const { otp, purpose } = await takeOtp(harness, email);
    expect(purpose).toBe("forget-password");
    const reset = await anonymous.auth("/email-otp/reset-password", {
      email,
      otp,
      password: newPassword(),
    });
    expect(reset.status).toBe(200);
    await expectError(session.rpc.user.me(), "UNAUTHENTICATED");
  });

  it("limits sign-in attempts per client", async () => {
    const attacker = createSession(harness);
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      statuses.push(
        (await attacker.auth("/sign-in/email", { email: newEmail(), password: "wrong-password-1" }))
          .status,
      );
    }
    expect(statuses.slice(0, 5).every((status) => status !== 429)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  it("limits password attempts per account, however many addresses they come from", async () => {
    const { email, password } = await signedInUser();
    // Each attempt from a new session: a new client address, as a forged or rotated
    // X-Forwarded-For would give, so the per-address limit never applies.
    const attempt = (guess: string) =>
      createSession(harness).auth("/sign-in/email", { email, password: guess });
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) statuses.push((await attempt(`wrong-password-${i}`)).status);
    expect(statuses.every((status) => status === 401)).toBe(true);
    const locked = await attempt(password);
    expect(locked.status).toBe(429);
    expect(locked.body).toMatchObject({ code: "RATE_LIMITED" });
    // Other accounts are untouched.
    const other = await signedInUser();
    expect(
      (
        await createSession(harness).auth("/sign-in/email", {
          email: other.email,
          password: other.password,
        })
      ).status,
    ).toBe(200);
  });
});

describe("account security", () => {
  it("keeps two-factor backup codes encrypted at rest, and each works once", async () => {
    const { session, email, password } = await signedInUser();
    const enabled = await session.auth<{ totpURI: string; backupCodes: string[] }>(
      "/two-factor/enable",
      { password },
    );
    expect(enabled.status).toBe(200);
    const secret = new URL(enabled.body.totpURI).searchParams.get("secret") ?? "";
    expect((await session.auth("/two-factor/verify-totp", { code: totp(secret) })).status).toBe(
      200,
    );

    // What's stored reveals none of the codes.
    const db = new pg.Client({ connectionString: harness.testDb.urlFor("app_api") });
    await db.connect();
    const stored = await db
      .query<{ backup_codes: string }>(
        `SELECT t.backup_codes FROM auth.two_factor t JOIN auth."user" u ON u.id = t.user_id WHERE u.email = $1`,
        [email],
      )
      .finally(() => db.end());
    const [code, ...others] = enabled.body.backupCodes;
    expect(code).toBeDefined();
    for (const backup of enabled.body.backupCodes)
      expect(stored.rows[0]?.backup_codes).not.toContain(backup);

    const again = createSession(harness);
    const signIn = await again.auth<{ twoFactorRedirect?: boolean }>("/sign-in/email", {
      email,
      password,
    });
    expect(signIn.body.twoFactorRedirect).toBe(true);
    expect((await again.auth("/two-factor/verify-backup-code", { code })).status).toBe(200);
    expect(await again.rpc.user.me()).toMatchObject({ email });

    const replay = createSession(harness);
    await replay.auth("/sign-in/email", { email, password });
    expect((await replay.auth("/two-factor/verify-backup-code", { code })).status).not.toBe(200);
    expect(others).toHaveLength(9);
  });

  it("changing the password emails a security alert to the account", async () => {
    const { session, email, password } = await signedInUser();
    const changed = await session.auth("/change-password", {
      currentPassword: password,
      newPassword: newPassword(),
    });
    expect(changed.status).toBe(200);
    const alert = await takeNotification(harness, "auth.security-alert", email);
    expect(alert.data).toMatchObject({
      event: "password-changed",
      securityUrl: expect.stringContaining("/settings/security"),
    });
  });

  it("a failed change sends no alert", async () => {
    const { session, email } = await signedInUser();
    const failed = await session.auth("/change-password", {
      currentPassword: "wrong-password",
      newPassword: newPassword(),
    });
    expect(failed.status).toBe(400);
    await expect(takeNotification(harness, "auth.security-alert", email)).rejects.toThrow(
      /No auth.security-alert/,
    );
  });

  it("changing the email needs codes from both addresses and alerts the old one", async () => {
    const { session, email, password } = await signedInUser();
    const next = newEmail();

    // Without the current address's code, nothing is sent to the new one.
    const blocked = await session.auth("/email-otp/request-email-change", { newEmail: next });
    expect(blocked.status).toBe(400);

    await session.auth("/email-otp/send-verification-otp", { email, type: "email-verification" });
    const current = await takeOtp(harness, email);
    expect(
      (await session.auth("/email-otp/request-email-change", { newEmail: next, otp: current.otp }))
        .status,
    ).toBe(200);
    const confirmation = await takeOtp(harness, next);
    expect(confirmation.purpose).toBe("change-email");
    expect(
      (await session.auth("/email-otp/change-email", { newEmail: next, otp: confirmation.otp }))
        .status,
    ).toBe(200);

    const alert = await takeNotification(harness, "auth.security-alert", email);
    expect(alert.data).toMatchObject({ event: "email-changed", newEmail: next });
    expect((await session.rpc.user.me()).email).toBe(next);
    // The new address signs in; the old one no longer exists.
    const fresh = createSession(harness);
    expect((await fresh.auth("/sign-in/email", { email: next, password })).status).toBe(200);
    expect((await createSession(harness).auth("/sign-in/email", { email, password })).status).toBe(
      401,
    );
  });

  it("the link-based email change is disabled", async () => {
    const { session } = await signedInUser();
    const response = await session.auth("/change-email", { newEmail: newEmail() });
    expect(response.status).not.toBe(200);
  });
});

describe("time limits", () => {
  it("an expired verification code is refused, and a new one works", async () => {
    const session = createSession(harness);
    const email = newEmail();
    await session.auth("/sign-up/email", { email, password: newPassword(), name: "Late" });
    const { otp } = await takeOtp(harness, email);
    await expireOtps(harness, email);
    const late = await session.auth<{ code: string }>("/email-otp/verify-email", { email, otp });
    expect(late.status).toBe(400);
    expect(late.body.code).toBe("OTP_EXPIRED");

    await session.auth("/email-otp/send-verification-otp", { email, type: "email-verification" });
    const fresh = await takeOtp(harness, email);
    expect((await session.auth("/email-otp/verify-email", { email, otp: fresh.otp })).status).toBe(
      200,
    );
  });

  it("a session older than the fresh window can't list devices or add passkeys", async () => {
    const { session } = await signedInUser();
    expect((await session.authGet<unknown[]>("/list-sessions")).length).toBe(1);
    await editSession(harness, session, (stored) => {
      stored.createdAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    });

    const devices = await session.authGet<{ code: string }>("/list-sessions");
    expect(devices.code).toBe("SESSION_NOT_FRESH");
    const passkey = await session.authGet<{ code: string }>("/passkey/generate-register-options");
    expect(passkey.code).toBe("SESSION_NOT_FRESH");
    // Everyday use is unaffected.
    expect((await session.rpc.user.me()).email).toBeDefined();
  });

  it("a session past its expiry is rejected", async () => {
    const { session } = await signedInUser();
    await editSession(harness, session, (stored) => {
      stored.expiresAt = new Date(Date.now() - 1000).toISOString();
    });
    await expectError(session.rpc.user.me(), "UNAUTHENTICATED");
  });
});

describe("organizations and the audit trail", () => {
  /** Outbox rows (events) for an aggregate key, read as the database superuser. */
  async function outbox(where: string, params: unknown[]) {
    const client = new pg.Client({ connectionString: harness.testDb.urlFor("postgres") });
    await client.connect();
    try {
      const { rows } = await client.query<{
        name: string;
        payload: Record<string, unknown>;
        org_id: string | null;
        actor_id: string | null;
      }>(
        `SELECT name, payload, org_id, actor_id FROM app.outbox_event WHERE ${where} ORDER BY id`,
        params,
      );
      return rows;
    } finally {
      await client.end();
    }
  }

  /** A team organization with an owner and a member (who joined by invitation). */
  async function team() {
    const owner = await signedInUser();
    const member = await signedInUser();
    const org = await owner.session.auth<{ id: string }>("/organization/create", {
      name: "Team",
      slug: `team-${randomUUID().slice(0, 8)}`,
    });
    await owner.session.auth("/organization/invite-member", {
      email: member.email,
      role: "member",
      organizationId: org.body.id,
    });
    const invitation = await takeNotification(harness, "org.invitation", member.email);
    const invitationId = new URL(invitation.data.acceptUrl).pathname.split("/").at(-1);
    await member.session.auth("/organization/accept-invitation", { invitationId });
    await member.session.auth("/organization/set-active", { organizationId: org.body.id });
    await owner.session.auth("/organization/set-active", { organizationId: org.body.id });
    const memberId = (await member.session.rpc.user.me()).id;
    return { owner, member, orgId: org.body.id, memberId };
  }

  it("records sign-up, the personal workspace and sessions as events", async () => {
    const { session } = await signedInUser();
    const { id: userId } = await session.rpc.user.me();
    const events = await outbox("actor_id = $1::uuid", [userId]);
    const names = events.map((event) => event.name);
    expect(names).toEqual(
      expect.arrayContaining(["auth.signed_up.v1", "org.created.v1", "auth.session_started.v1"]),
    );
    expect(events.find((e) => e.name === "auth.session_started.v1")?.payload).toMatchObject({
      userId,
      method: "email-code",
    });

    await session.auth("/sign-out");
    const after = await outbox("actor_id = $1::uuid AND name = 'auth.session_ended.v1'", [userId]);
    expect(after.at(-1)?.payload).toMatchObject({ reason: "sign-out" });
  });

  it("records membership changes in the organization's own log, with who did them", async () => {
    const { owner, orgId, memberId } = await team();
    const { id: ownerId } = await owner.session.rpc.user.me();
    const { members } = await owner.session.authGet<{ members: { id: string; userId: string }[] }>(
      `/organization/list-members?organizationId=${orgId}`,
    );
    const target = members.find((m) => m.userId === memberId)?.id;
    await owner.session.auth("/organization/update-member-role", {
      memberId: target,
      role: "admin",
      organizationId: orgId,
    });

    const events = await outbox("org_id = $1::uuid", [orgId]);
    // Creating an organization adds its creator as the first member.
    expect(events.map((e) => e.name)).toEqual([
      "org.member_added.v1",
      "org.created.v1",
      "org.invitation_sent.v1",
      "org.member_added.v1",
      "org.member_role_changed.v1",
    ]);
    expect(events.at(-1)).toMatchObject({
      actor_id: ownerId,
      payload: { role: "admin", previousRole: "member" },
    });
  });

  it("limits invitations, per address and per workspace, so our domain can't be used to spam", async () => {
    const { owner, orgId } = await team();
    const invite = (email: string, resend = false) =>
      owner.session.auth<{ code?: string }>("/organization/invite-member", {
        email,
        role: "member",
        organizationId: orgId,
        resend,
      });
    // One address: three emails a day, however they're asked for.
    const target = newEmail();
    expect((await invite(target)).status).toBe(200);
    expect((await invite(target, true)).status).toBe(200);
    expect((await invite(target, true)).status).toBe(200);
    expect((await invite(target, true)).status).toBe(429);
    // One workspace: PENDING_INVITATION_LIMIT waiting at once (the team already has one,
    // its member's accepted one doesn't count, and the one above does).
    let sent = 1;
    while (sent < PENDING_INVITATION_LIMIT) {
      expect((await invite(newEmail())).status).toBe(200);
      sent++;
    }
    const over = await invite(newEmail());
    expect(over.status).toBe(403);
    expect(over.body.code).toBe("INVITATION_LIMIT_REACHED");
  });

  it(`caps the workspaces one account belongs to at ${ORGANIZATION_LIMIT}`, async () => {
    const { session } = await signedInUser();
    const create = () =>
      session.auth<{ code?: string }>("/organization/create", {
        name: "Many",
        slug: `many-${randomUUID().slice(0, 8)}`,
      });
    // The personal workspace is the first.
    for (let count = 1; count < ORGANIZATION_LIMIT; count++)
      expect((await create()).status).toBe(200);
    const over = await create();
    expect(over.status).toBe(403);
    expect(over.body.code).toBe("YOU_HAVE_REACHED_THE_MAXIMUM_NUMBER_OF_ORGANIZATIONS");
  });

  it("a removed member loses access on their very next request", async () => {
    const { owner, member, orgId } = await team();
    await member.session.rpc.todo.create({ title: "Mine for now" });

    await owner.session.auth("/organization/remove-member", {
      memberIdOrEmail: member.email,
      organizationId: orgId,
    });
    await expectError(member.session.rpc.todo.list({ limit: 20 }), "NO_ACTIVE_ORGANIZATION");
    await expectError(
      member.session.rpc.todo.create({ title: "Sneaky" }),
      "NO_ACTIVE_ORGANIZATION",
    );
  });

  it("a member who leaves loses access everywhere at once, and the leave is recorded", async () => {
    const { member, orgId, memberId } = await team();
    // A second session (another device), already holding the cached role.
    const elsewhere = createSession(harness);
    await elsewhere.auth("/sign-in/email", { email: member.email, password: member.password });
    await elsewhere.auth("/organization/set-active", { organizationId: orgId });
    await elsewhere.rpc.todo.list({ limit: 20 });

    expect(
      (await member.session.auth("/organization/leave", { organizationId: orgId })).status,
    ).toBe(200);
    await expectError(elsewhere.rpc.todo.list({ limit: 20 }), "NO_ACTIVE_ORGANIZATION");
    const removed = await outbox("org_id = $1::uuid AND name = 'org.member_removed.v1'", [orgId]);
    expect(removed).toEqual([
      expect.objectContaining({
        actor_id: memberId,
        payload: expect.objectContaining({ userId: memberId }),
      }),
    ]);
  });

  it("records a member's departure when they delete their account", async () => {
    const { member, orgId, memberId } = await team();
    expect((await member.session.auth("/delete-user", { password: member.password })).status).toBe(
      200,
    );
    const removed = await outbox("org_id = $1::uuid AND name = 'org.member_removed.v1'", [orgId]);
    expect(removed).toEqual([
      expect.objectContaining({
        actor_id: memberId,
        payload: expect.objectContaining({ userId: memberId }),
      }),
    ]);
  });

  it("only owners and admins read the audit log, and only their organization's", async () => {
    const { owner, member, orgId } = await team();
    // The worker writes the audit log; here, rows are written directly as it would.
    const admin = new pg.Client({ connectionString: harness.testDb.urlFor("postgres") });
    await admin.connect();
    await admin.query("SELECT audit.ensure_partitions(1, 1)");
    await admin.query(
      `INSERT INTO audit.audit_log (id, occurred_at, name, key, payload, org_id, source)
       VALUES (uuidv7(), now(), 'todo.created.v1', 'k', '{"title":"Audited"}', $1, 'app'),
              (uuidv7(), now(), 'todo.created.v1', 'k', '{"title":"Other org"}', $2, 'app')`,
      [orgId, randomUUID()],
    );
    await admin.end();

    const log = await owner.session.rpc.audit.list({ limit: 20 });
    expect(log.items.map((entry) => entry.payload.title)).toEqual(["Audited"]);
    await expectError(member.session.rpc.audit.list({ limit: 20 }), "FORBIDDEN");
  });

  it("reads a stored role by an allow-list: an unknown one grants nothing, a compound one its strongest part", async () => {
    const { member, orgId, memberId } = await team();
    const setRole = async (role: string) => {
      const admin = new pg.Client({ connectionString: harness.testDb.urlFor("postgres") });
      await admin.connect();
      await admin
        .query("UPDATE auth.member SET role = $1 WHERE organization_id = $2 AND user_id = $3", [
          role,
          orgId,
          memberId,
        ])
        .finally(() => admin.end());
      // As a membership change through better-auth would, forget the cached role.
      const cached = await harness.redis.keys(`cache:membership:*${orgId}:${memberId}`);
      if (cached.length) await harness.redis.del(...cached);
    };

    // better-auth joins several roles with commas: the strongest one counts.
    await setRole("member,admin");
    expect((await member.session.rpc.audit.list({ limit: 20 })).items).toEqual([]);
    // A role the API doesn't know (a future "viewer", a typo, a hand edit) isn't an admin,
    // nor a member: it grants nothing at all.
    await setRole("viewer");
    await expectError(member.session.rpc.audit.list({ limit: 20 }), "NO_ACTIVE_ORGANIZATION");
    await expectError(member.session.rpc.todo.list({}), "NO_ACTIVE_ORGANIZATION");
    await setRole("member,viewer");
    await expectError(member.session.rpc.todo.list({}), "NO_ACTIVE_ORGANIZATION");
    await setRole("member");
    await expectError(member.session.rpc.audit.list({ limit: 20 }), "FORBIDDEN");
    expect((await member.session.rpc.todo.list({})).items).toEqual([]);
  });
});

describe("webhook endpoints", () => {
  const url = "http://127.0.0.1:9/hook";

  it("limits test sends per workspace, so our servers can't flood an endpoint", async () => {
    const { session } = await signedInUser();
    const { endpoint } = await session.rpc.webhooks.createEndpoint({
      url,
      events: ["todo.created.v1"],
    });
    for (let i = 0; i < 10; i++) await session.rpc.webhooks.sendTest({ id: endpoint.id });
    const limited = await expectError(
      session.rpc.webhooks.sendTest({ id: endpoint.id }),
      "RATE_LIMITED",
    );
    expect(limited.data.params).toMatchObject({ retryAfterSeconds: expect.any(Number) });
  });

  it("needs a recent sign-in to add one or point it elsewhere", async () => {
    const { session } = await signedInUser();
    const { endpoint } = await session.rpc.webhooks.createEndpoint({
      url,
      events: ["todo.created.v1"],
    });
    await editSession(harness, session, (stored) => {
      stored.createdAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    });
    await expectError(
      session.rpc.webhooks.createEndpoint({ url, events: ["todo.created.v1"] }),
      "FRESH_SESSION_REQUIRED",
    );
    await expectError(
      session.rpc.webhooks.updateEndpoint({ id: endpoint.id, url: "http://127.0.0.1:9/other" }),
      "FRESH_SESSION_REQUIRED",
    );
    // Anything else about it doesn't.
    await expect(
      session.rpc.webhooks.updateEndpoint({ id: endpoint.id, enabled: false }),
    ).resolves.toMatchObject({ url });
  });

  it("returns the signing secret once and keeps it encrypted at rest", async () => {
    const { session } = await signedInUser();
    const created = await session.rpc.webhooks.createEndpoint({ url, events: ["todo.created.v1"] });
    expect(created.secret).toMatch(/^whsec_/);
    expect(created.endpoint).toMatchObject({ url, events: ["todo.created.v1"], disabledAt: null });
    expect(JSON.stringify(await session.rpc.webhooks.listEndpoints())).not.toContain(
      created.secret,
    );

    const client = new pg.Client({ connectionString: harness.testDb.urlFor("postgres") });
    await client.connect();
    const { rows } = await client.query("SELECT secret FROM webhooks.endpoint WHERE id = $1", [
      created.endpoint.id,
    ]);
    const events = await client.query("SELECT name FROM app.outbox_event WHERE key = $1", [
      created.endpoint.id,
    ]);
    await client.end();
    expect(rows[0].secret).not.toContain(created.secret.slice(6));
    expect(rows[0].secret).toMatch(/^v1\./);
    expect(events.rows.map((row) => row.name)).toEqual(["webhook.endpoint_created.v1"]);

    const rotated = await session.rpc.webhooks.rotateSecret({ id: created.endpoint.id });
    expect(rotated.secret).not.toBe(created.secret);
    // The replaced secret keeps signing for the overlap (apps/webhooks signs with both).
    const after = new pg.Client({ connectionString: harness.testDb.urlFor("postgres") });
    await after.connect();
    const { rows: stored } = await after
      .query<{ secret: string; previous_secret: string; previous_secret_expires_at: Date }>(
        "SELECT secret, previous_secret, previous_secret_expires_at FROM webhooks.endpoint WHERE id = $1",
        [created.endpoint.id],
      )
      .finally(() => after.end());
    expect(stored[0]?.previous_secret).toBe(rows[0].secret);
    expect(stored[0]?.secret).not.toBe(rows[0].secret);
    const overlap = (stored[0]?.previous_secret_expires_at.getTime() ?? 0) - Date.now();
    expect(overlap).toBeGreaterThan((WEBHOOK_SECRET_OVERLAP_HOURS - 1) * 3_600_000);
    expect(overlap).toBeLessThanOrEqual(WEBHOOK_SECRET_OVERLAP_HOURS * 3_600_000);
  });

  it("refuses URLs that point at private or unresolvable hosts", async () => {
    const { session } = await signedInUser();
    for (const bad of [
      "http://10.0.0.1/hook",
      "http://169.254.169.254/latest",
      "https://does-not-exist.invalid/",
    ]) {
      await expectError(
        session.rpc.webhooks.createEndpoint({ url: bad }),
        "WEBHOOK_URL_NOT_ALLOWED",
      );
    }
  });

  it("turns an endpoint off and on, and records who changed what", async () => {
    const { session } = await signedInUser();
    const { endpoint } = await session.rpc.webhooks.createEndpoint({ url });
    const off = await session.rpc.webhooks.updateEndpoint({ id: endpoint.id, enabled: false });
    expect(off).toMatchObject({ disabledReason: "manual" });
    expect(off.disabledAt).toBeInstanceOf(Date);
    const on = await session.rpc.webhooks.updateEndpoint({
      id: endpoint.id,
      enabled: true,
      description: "Prod",
    });
    expect(on).toMatchObject({ disabledAt: null, disabledReason: null, description: "Prod" });
  });

  it("queues a test event for the delivery service", async () => {
    const { session } = await signedInUser();
    const { endpoint } = await session.rpc.webhooks.createEndpoint({ url });
    await session.rpc.webhooks.sendTest({ id: endpoint.id });
    const queue = new Queue("webhook-deliveries", {
      connection: harness.redis,
      prefix: queuePrefix("webhook-deliveries"),
    });
    const jobs = await queue.getJobs(["waiting"]);
    await queue.close();
    expect(
      jobs.some((job) => job.name === "send-test" && job.data.payload.endpointId === endpoint.id),
    ).toBe(true);
  });

  it("is for owners and admins of the organization only", async () => {
    const owner = await signedInUser();
    const { endpoint } = await owner.session.rpc.webhooks.createEndpoint({ url });
    const stranger = await signedInUser();
    expect(await stranger.session.rpc.webhooks.listEndpoints()).toEqual([]);
    await expectError(
      stranger.session.rpc.webhooks.deleteEndpoint({ id: endpoint.id }),
      "WEBHOOK_ENDPOINT_NOT_FOUND",
    );
    await expectError(
      stranger.session.rpc.webhooks.listDeliveries({ id: endpoint.id, limit: 20 }),
      "WEBHOOK_ENDPOINT_NOT_FOUND",
    );
  });

  it("limits endpoints per organization", async () => {
    const { session } = await signedInUser();
    for (let i = 0; i < 20; i++) await session.rpc.webhooks.createEndpoint({ url });
    const error = await expectError(
      session.rpc.webhooks.createEndpoint({ url }),
      "WEBHOOK_ENDPOINT_LIMIT",
    );
    expect(error.data.params).toEqual({ max: 20 });
  });
});

describe("realtime", () => {
  /** Reads a stream until `count` messages arrive (or 3 s pass). */
  async function read(stream: AsyncIterable<unknown>, count: number) {
    const received: unknown[] = [];
    const reading = (async () => {
      for await (const message of stream) {
        received.push(message);
        if (received.length === count) return;
      }
    })();
    await Promise.race([reading, new Promise((resolve) => setTimeout(resolve, 3_000))]);
    return received;
  }

  it("refuses an eleventh stream for one user with a typed error, and frees slots on close", async () => {
    const { session } = await signedInUser();
    const controllers = Array.from({ length: 10 }, () => new AbortController());
    const streams = await Promise.all(
      controllers.map((controller) =>
        session.rpc.realtime.subscribe(undefined, { signal: controller.signal }),
      ),
    );
    // Iterating is what opens each stream on the server.
    const readers = streams.map((stream) => read(stream, 1));
    await new Promise((resolve) => setTimeout(resolve, 300));
    await expectError(
      (async () => {
        const extra = await session.rpc.realtime.subscribe();
        for await (const _ of extra) break;
      })(),
      "RATE_LIMITED",
    );
    for (const controller of controllers) controller.abort();
    // Aborting ends each reader with an AbortError: expected.
    await Promise.allSettled(readers);
    await new Promise((resolve) => setTimeout(resolve, 300));
    // Closed streams give their slots back.
    const controller = new AbortController();
    const again = await session.rpc.realtime.subscribe(undefined, { signal: controller.signal });
    let refused: unknown;
    const reading = read(again, 1).catch((error: unknown) => {
      refused = error;
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(refused).toBeUndefined();
    controller.abort();
    await reading;
  });

  it("streams messages for the user and their active workspace only", async () => {
    const { session } = await signedInUser();
    const me = await session.rpc.user.me();
    const controller = new AbortController();
    const stream = await session.rpc.realtime.subscribe(undefined, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 200)); // subscribed
    await publishRealtime(harness.redis, realtimeChannel.org(randomUUID()), {
      type: "todos.changed",
    });
    await publishRealtime(harness.redis, realtimeChannel.org(me.activeOrganizationId as string), {
      type: "todos.changed",
    });
    await publishRealtime(harness.redis, realtimeChannel.user(me.id), {
      type: "notifications.changed",
    });
    const received = await read(stream, 2);
    controller.abort();
    expect(received).toEqual([{ type: "todos.changed" }, { type: "notifications.changed" }]);
  });

  it("needs a session", async () => {
    const anonymous = createSession(harness);
    const stream = anonymous.rpc.realtime.subscribe(undefined);
    await expectError(
      stream.then((iterator) => iterator[Symbol.asyncIterator]().next()),
      "UNAUTHENTICATED",
    );
  });
});

describe("notifications", () => {
  /** Puts in-app notifications in a user's inbox, as apps/notifications does. */
  async function deliver(userId: string, titles: string[]) {
    const client = new pg.Client({ connectionString: harness.testDb.urlFor("postgres") });
    await client.connect();
    for (const title of titles) {
      await client.query(
        `INSERT INTO notifications.notification (user_id, template, data, link) VALUES ($1, 'todo.reminder', $2, '/dashboard')`,
        [userId, JSON.stringify({ todoId: randomUUID(), title })],
      );
    }
    await client.end();
  }

  it("lists the inbox newest first, counts unread, marks read", async () => {
    const { session } = await signedInUser();
    const me = await session.rpc.user.me();
    await deliver(me.id, ["first", "second", "third"]);
    const page = await session.rpc.notifications.list({ limit: 2 });
    expect(page.items.map((item) => item.data.title)).toEqual(["third", "second"]);
    expect(page.nextCursor).not.toBeNull();
    expect(await session.rpc.notifications.unreadCount()).toEqual({ count: 3 });

    await session.rpc.notifications.markRead({ ids: [page.items[0]?.id as string] });
    expect(await session.rpc.notifications.unreadCount()).toEqual({ count: 2 });
    await session.rpc.notifications.markAllRead();
    expect(await session.rpc.notifications.unreadCount()).toEqual({ count: 0 });
  });

  it("keeps each inbox private", async () => {
    const owner = await signedInUser();
    await deliver((await owner.session.rpc.user.me()).id, ["private"]);
    const other = await signedInUser();
    expect((await other.session.rpc.notifications.list({ limit: 20 })).items).toEqual([]);
  });

  it("saves preferences, digest and quiet hours, but security email can't be turned off", async () => {
    const { session } = await signedInUser();
    const defaults = await session.rpc.notifications.preferences();
    expect(defaults.categories.map((c) => c.name)).toEqual(["workspace", "activity"]);
    expect(defaults.categories.every((c) => c.channels.every((ch) => ch.enabled))).toBe(true);

    const updated = await session.rpc.notifications.updatePreferences({
      channels: [{ category: "activity", channel: "email", enabled: false }],
      dailyDigest: true,
      quietHours: { start: 22 * 60, end: 7 * 60 },
    });
    expect(updated.categories.find((c) => c.name === "activity")?.channels).toContainEqual({
      channel: "email",
      enabled: false,
    });
    expect(updated).toMatchObject({ dailyDigest: true, quietHours: { start: 1320, end: 420 } });

    await expectError(
      session.rpc.notifications.updatePreferences({
        channels: [{ category: "security", channel: "email", enabled: false }],
      }),
      "VALIDATION_FAILED",
    );
  });

  it("unsubscribes from a signed link, one-click included, and rejects forgeries", async () => {
    const { session } = await signedInUser();
    const { id } = await session.rpc.user.me();
    const tokens = createSignedTokens(process.env.UNSUBSCRIBE_SECRET as string);

    const anonymous = createSession(harness);
    expect(
      await anonymous.rpc.notifications.unsubscribe({
        token: tokens.sign("unsubscribe", [id, "activity"]),
      }),
    ).toEqual({ category: "activity" });
    const oneClick = await fetch(
      `${harness.baseUrl}/api/v1/notifications/unsubscribe?token=${encodeURIComponent(tokens.sign("unsubscribe", [id, "workspace"]))}`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "List-Unsubscribe=One-Click",
      },
    );
    expect(oneClick.status).toBe(200);
    const preferences = await session.rpc.notifications.preferences();
    for (const category of preferences.categories) {
      expect(category.channels.find((ch) => ch.channel === "email")?.enabled).toBe(false);
    }

    await expectError(
      anonymous.rpc.notifications.unsubscribe({ token: "forged.token" }),
      "UNSUBSCRIBE_LINK_INVALID",
    );
    await expectError(
      anonymous.rpc.notifications.unsubscribe({
        token: tokens.sign("unsubscribe", [id, "security"]),
      }),
      "UNSUBSCRIBE_LINK_INVALID",
    );
  });
});

describe("phone number", () => {
  const newPhone = () => `+1415${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;

  async function addPhone(session: ReturnType<typeof createSession>, phoneNumber = newPhone()) {
    await session.rpc.user.sendPhoneCode({ phoneNumber });
    const { data } = await takeNotification(harness, "auth.phone-code", phoneNumber);
    const me = await session.rpc.user.verifyPhone({ phoneNumber, code: data.code });
    return { phoneNumber, me, code: data.code };
  }

  async function outboxEvents(userId: string) {
    const client = new pg.Client({ connectionString: harness.testDb.urlFor("postgres") });
    await client.connect();
    const { rows } = await client.query<{ payload: { change: string } }>(
      "SELECT payload FROM app.outbox_event WHERE name = 'auth.phone_changed.v1' AND key = $1 ORDER BY occurred_at",
      [userId],
    );
    await client.end();
    return rows.map((row) => row.payload.change);
  }

  it("adds a number once the texted code matches, audits it and alerts the account", async () => {
    const { session, email } = await signedInUser("es");
    const me = await session.rpc.user.me();
    expect(me.phoneNumber).toBeNull();

    const phoneNumber = newPhone();
    // Spaces, dashes and brackets are fine; the number is stored as E.164.
    const formatted = `${phoneNumber.slice(0, 2)} (${phoneNumber.slice(2, 5)}) ${phoneNumber.slice(5, 8)}-${phoneNumber.slice(8)}`;
    expect(await session.rpc.user.sendPhoneCode({ phoneNumber: formatted })).toEqual({
      expiresInSeconds: 600,
    });
    const text = await takeNotification(harness, "auth.phone-code", phoneNumber);
    expect(text.to.locale).toBe("es");
    expect(text.data.code).toMatch(/^\d{6}$/);

    const updated = await session.rpc.user.verifyPhone({ phoneNumber, code: text.data.code });
    expect(updated.phoneNumber).toBe(phoneNumber);
    expect((await session.rpc.user.me()).phoneNumber).toBe(phoneNumber);
    expect(await outboxEvents(me.id)).toEqual(["added"]);

    const alert = await takeNotification(harness, "auth.security-alert", email);
    expect(alert.data.event).toBe("phone-added");
    expect(alert.to.phone).toBe(phoneNumber);
  });

  it("rejects wrong codes, and forgets the code after five wrong guesses", async () => {
    const { session } = await signedInUser();
    const phoneNumber = newPhone();
    await session.rpc.user.sendPhoneCode({ phoneNumber });
    const { data } = await takeNotification(harness, "auth.phone-code", phoneNumber);
    const wrong = data.code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) {
      await expectError(
        session.rpc.user.verifyPhone({ phoneNumber, code: wrong }),
        "PHONE_CODE_INVALID",
      );
    }
    // The right code no longer works: guessing can't continue past the limit.
    await expectError(
      session.rpc.user.verifyPhone({ phoneNumber, code: data.code }),
      "PHONE_CODE_INVALID",
    );
    expect((await session.rpc.user.me()).phoneNumber).toBeNull();
  });

  it("a code only verifies the number it was sent to, and only once", async () => {
    const { session } = await signedInUser();
    const phoneNumber = newPhone();
    await session.rpc.user.sendPhoneCode({ phoneNumber });
    const { data } = await takeNotification(harness, "auth.phone-code", phoneNumber);
    await expectError(
      session.rpc.user.verifyPhone({ phoneNumber: newPhone(), code: data.code }),
      "PHONE_CODE_INVALID",
    );
    await session.rpc.user.verifyPhone({ phoneNumber, code: data.code });
    await session.rpc.user.removePhone();
    await expectError(
      session.rpc.user.verifyPhone({ phoneNumber, code: data.code }),
      "PHONE_CODE_INVALID",
    );
  });

  it("a code sent to one account can't verify another's", async () => {
    const first = await signedInUser();
    const second = await signedInUser();
    const phoneNumber = newPhone();
    await first.session.rpc.user.sendPhoneCode({ phoneNumber });
    const { data } = await takeNotification(harness, "auth.phone-code", phoneNumber);
    await expectError(
      second.session.rpc.user.verifyPhone({ phoneNumber, code: data.code }),
      "PHONE_CODE_INVALID",
    );
  });

  it("a number can be on one account only", async () => {
    const owner = await signedInUser();
    const { phoneNumber } = await addPhone(owner.session);
    const other = await signedInUser();
    await expectError(other.session.rpc.user.sendPhoneCode({ phoneNumber }), "PHONE_NUMBER_TAKEN");
    // Its own number again: nothing to verify.
    await expectError(owner.session.rpc.user.sendPhoneCode({ phoneNumber }), "PHONE_NUMBER_TAKEN");
  });

  it("when two accounts verify the same number at once, the second is refused", async () => {
    const first = await signedInUser();
    const second = await signedInUser();
    const phoneNumber = newPhone();
    await first.session.rpc.user.sendPhoneCode({ phoneNumber });
    const firstCode = (await takeNotification(harness, "auth.phone-code", phoneNumber)).data.code;
    await second.session.rpc.user.sendPhoneCode({ phoneNumber });
    const secondCode = (await takeNotification(harness, "auth.phone-code", phoneNumber)).data.code;

    await first.session.rpc.user.verifyPhone({ phoneNumber, code: firstCode });
    await expectError(
      second.session.rpc.user.verifyPhone({ phoneNumber, code: secondCode }),
      "PHONE_NUMBER_TAKEN",
    );
    expect((await second.session.rpc.user.me()).phoneNumber).toBeNull();
  });

  it("limits texts per account and per number", async () => {
    const { session } = await signedInUser();
    for (let i = 0; i < 5; i++) await session.rpc.user.sendPhoneCode({ phoneNumber: newPhone() });
    const limited = await expectError(
      session.rpc.user.sendPhoneCode({ phoneNumber: newPhone() }),
      "RATE_LIMITED",
    );
    expect(limited.data?.params).toMatchObject({ retryAfterSeconds: expect.any(Number) });

    // Three accounts texting one number (someone spamming a victim) hit the number's limit.
    const victim = newPhone();
    for (let i = 0; i < 3; i++) {
      await (await signedInUser()).session.rpc.user.sendPhoneCode({ phoneNumber: victim });
    }
    await expectError(
      (await signedInUser()).session.rpc.user.sendPhoneCode({ phoneNumber: victim }),
      "RATE_LIMITED",
    );
  });

  it("removing the number audits it and tells the number that was removed", async () => {
    const { session, email } = await signedInUser();
    const me = await session.rpc.user.me();
    const { phoneNumber } = await addPhone(session);
    await takeNotification(harness, "auth.security-alert", email);

    expect((await session.rpc.user.removePhone()).phoneNumber).toBeNull();
    expect(await outboxEvents(me.id)).toEqual(["added", "removed"]);
    const alert = await takeNotification(harness, "auth.security-alert", email);
    expect(alert.data.event).toBe("phone-removed");
    expect(alert.to.phone).toBe(phoneNumber);
  });

  it("security alerts are texted to the verified number too", async () => {
    const { session, email, password } = await signedInUser();
    const { phoneNumber } = await addPhone(session);
    await takeNotification(harness, "auth.security-alert", email);
    await session.auth("/change-password", {
      currentPassword: password,
      newPassword: newPassword(),
    });
    const alert = await takeNotification(harness, "auth.security-alert", email);
    expect(alert).toMatchObject({
      data: { event: "password-changed" },
      to: { phone: phoneNumber },
    });
  });

  it("needs a recent sign-in to change the number", async () => {
    const { session } = await signedInUser();
    await editSession(harness, session, (stored) => {
      stored.createdAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    });
    await expectError(
      session.rpc.user.sendPhoneCode({ phoneNumber: newPhone() }),
      "FRESH_SESSION_REQUIRED",
    );
    await expectError(
      session.rpc.user.verifyPhone({ phoneNumber: newPhone(), code: "123456" }),
      "FRESH_SESSION_REQUIRED",
    );
    await expectError(session.rpc.user.removePhone(), "FRESH_SESSION_REQUIRED");
    // Reading it doesn't.
    await expect(session.rpc.user.me()).resolves.toMatchObject({ phoneNumber: null });
  });

  it("rejects numbers that aren't E.164, and requires a session", async () => {
    const { session } = await signedInUser();
    for (const phoneNumber of ["4155550123", "+0123456789", "+1", "+1415555012345678", "phone"]) {
      await expectError(session.rpc.user.sendPhoneCode({ phoneNumber }), "VALIDATION_FAILED");
    }
    await expectError(
      session.rpc.user.verifyPhone({ phoneNumber: newPhone(), code: "12345" }),
      "VALIDATION_FAILED",
    );
    await expectError(
      createSession(harness).rpc.user.sendPhoneCode({ phoneNumber: newPhone() }),
      "UNAUTHENTICATED",
    );
  });
});

describe("uploads and the profile picture", () => {
  const storage = new S3Storage({
    bucket: LOCAL_STORAGE.S3_BUCKET,
    region: "us-east-1",
    endpoint: LOCAL_STORAGE.S3_ENDPOINT,
    accessKeyId: LOCAL_STORAGE.S3_ACCESS_KEY_ID,
    secretAccessKey: LOCAL_STORAGE.S3_SECRET_ACCESS_KEY,
    forcePathStyle: true,
  });
  const png = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005050201a5b2a1d20000000049454e44ae426082",
    "hex",
  );

  async function sql(query: string, params: unknown[] = []) {
    const client = new pg.Client({ connectionString: harness.testDb.urlFor("postgres") });
    await client.connect();
    try {
      return (await client.query(query, params)).rows;
    } finally {
      await client.end();
    }
  }

  /** What apps/worker does once it has checked an upload. */
  async function markReady(fileId: string) {
    await storage.write(`files/${fileId}`, png, "image/webp");
    await sql(
      "UPDATE files.file SET status = 'ready', content_type = 'image/webp', size = $2, ready_at = now() WHERE id = $1",
      [fileId, png.length],
    );
  }

  async function uploaded(session: ReturnType<typeof createSession>) {
    const { file, upload } = await session.rpc.files.createUpload({
      purpose: "avatar",
      filename: "me.png",
      contentType: "image/png",
      size: png.length,
    });
    const put = await fetch(upload.url, { method: "PUT", headers: upload.headers, body: png });
    expect(put.status).toBe(200);
    return file;
  }

  it("signs an upload for exactly the file described, straight into quarantine", async () => {
    const { session } = await signedInUser();
    const { file, upload } = await session.rpc.files.createUpload({
      purpose: "avatar",
      filename: "me.png",
      contentType: "image/png",
      size: png.length,
    });
    expect(file).toMatchObject({ purpose: "avatar", status: "pending", filename: "me.png" });
    expect(new URL(upload.url).pathname).toContain(`/quarantine/${file.id}`);

    // A different type or size than was signed for is refused by storage itself.
    const swapped = await fetch(upload.url, {
      method: "PUT",
      headers: { ...upload.headers, "Content-Type": "text/html" },
      body: png,
    });
    expect(swapped.status).toBe(403);
    const bigger = Buffer.concat([png, png]);
    const resized = await fetch(upload.url, {
      method: "PUT",
      headers: { ...upload.headers, "Content-Length": String(bigger.length) },
      body: bigger,
    });
    expect(resized.status).toBe(403);

    const put = await fetch(upload.url, { method: "PUT", headers: upload.headers, body: png });
    expect(put.status).toBe(200);
    expect(await storage.head(`quarantine/${file.id}`)).toMatchObject({ size: png.length });
  });

  it("refuses types and sizes the purpose doesn't allow, before signing anything", async () => {
    const { session } = await signedInUser();
    const upload = (contentType: string, size: number) =>
      session.rpc.files.createUpload({ purpose: "avatar", filename: "x", contentType, size });
    const type = await expectError(upload("image/svg+xml", 100), "FILE_TYPE_NOT_ALLOWED");
    expect(type.data?.params).toMatchObject({ types: expect.stringContaining("image/png") });
    const size = await expectError(upload("image/png", 5_000_001), "FILE_TOO_LARGE");
    expect(size.data?.params).toMatchObject({ maxBytes: 5_000_000 });
    await expectError(upload("image/png", 0), "VALIDATION_FAILED");
  });

  it("completing queues one check, and only after the bytes are there", async () => {
    const { session } = await signedInUser();
    const { file } = await session.rpc.files.createUpload({
      purpose: "avatar",
      filename: "me.png",
      contentType: "image/png",
      size: png.length,
    });
    await expectError(session.rpc.files.completeUpload({ fileId: file.id }), "FILE_NOT_UPLOADED");

    const done = await uploaded(session);
    await session.rpc.files.completeUpload({ fileId: done.id });
    await session.rpc.files.completeUpload({ fileId: done.id });
    const queue = new Queue("files", { connection: harness.redis, prefix: queuePrefix("files") });
    const jobs = (await queue.getJobs(["waiting", "delayed", "prioritized"])).filter(
      (job) => job.data.payload.fileId === done.id,
    );
    await queue.close();
    expect(jobs.map((job) => job.id)).toEqual([done.id]);
  });

  it("keeps each user's uploads private", async () => {
    const owner = await signedInUser();
    const file = await uploaded(owner.session);
    const other = await signedInUser();
    await expectError(other.session.rpc.files.get({ fileId: file.id }), "FILE_NOT_FOUND");
    await expectError(
      other.session.rpc.files.completeUpload({ fileId: file.id }),
      "FILE_NOT_FOUND",
    );
    await expect(owner.session.rpc.files.get({ fileId: file.id })).resolves.toMatchObject({
      id: file.id,
    });
  });

  it("sets a checked upload as the picture, served to anyone signed in", async () => {
    const { session } = await signedInUser();
    const file = await uploaded(session);
    await expectError(session.rpc.user.setAvatar({ fileId: file.id }), "FILE_NOT_READY");
    await markReady(file.id);

    const me = await session.rpc.user.setAvatar({ fileId: file.id });
    expect(me.image).toBe(`/api/v1/files/${file.id}/content`);
    expect((await session.rpc.user.me()).image).toBe(me.image);

    // Anyone signed in gets a short-lived storage URL; nobody signed out does.
    const viewer = await signedInUser();
    const content = await fetch(`${harness.baseUrl}${me.image}`, {
      headers: { cookie: [...viewer.session.cookies()].map(([k, v]) => `${k}=${v}`).join("; ") },
      redirect: "manual",
    });
    expect(content.status).toBe(302);
    expect(content.headers.get("cache-control")).toBe("private, max-age=240");
    const image = await fetch(content.headers.get("location") as string);
    expect(image.status).toBe(200);
    expect(Buffer.from(await image.arrayBuffer())).toEqual(png);
    expect((await fetch(`${harness.baseUrl}${me.image}`, { redirect: "manual" })).status).toBe(401);
  });

  it("a picture must be the user's own, ready avatar", async () => {
    const owner = await signedInUser();
    const theirs = await uploaded(owner.session);
    await markReady(theirs.id);
    const other = await signedInUser();
    await expectError(other.session.rpc.user.setAvatar({ fileId: theirs.id }), "FILE_NOT_FOUND");
    await expectError(other.session.rpc.user.setAvatar({ fileId: randomUUID() }), "FILE_NOT_FOUND");
    // Pending files aren't served to anyone else, even by id.
    const pending = await uploaded(owner.session);
    const response = await fetch(`${harness.baseUrl}/api/v1/files/${pending.id}/content`, {
      headers: { cookie: [...other.session.cookies()].map(([k, v]) => `${k}=${v}`).join("; ") },
      redirect: "manual",
    });
    expect(response.status).toBe(404);
  });

  it("replacing or removing the picture deletes the old file and queues its objects", async () => {
    const { session } = await signedInUser();
    const first = await uploaded(session);
    await markReady(first.id);
    await session.rpc.user.setAvatar({ fileId: first.id });
    const second = await uploaded(session);
    await markReady(second.id);
    await session.rpc.user.setAvatar({ fileId: second.id });

    expect(await sql("SELECT id FROM files.file WHERE id = $1", [first.id])).toEqual([]);
    expect(
      (await sql("SELECT key FROM files.object_deletion WHERE key LIKE $1", [`%${first.id}`]))
        .map((row) => row.key)
        .sort(),
    ).toEqual([`files/${first.id}`, `quarantine/${first.id}`]);

    expect((await session.rpc.user.setAvatar({ fileId: null })).image).toBeNull();
    expect(await sql("SELECT id FROM files.file WHERE id = $1", [second.id])).toEqual([]);
  });

  it("the picture can't be set to an arbitrary URL through the auth API", async () => {
    const { session } = await signedInUser();
    const response = await session.auth("/update-user", {
      image: "https://tracker.example/pixel.gif",
    });
    expect(response.status).toBe(400);
    expect((await session.rpc.user.me()).image).toBeNull();
    // Other profile changes still work.
    expect((await session.auth("/update-user", { name: "Renamed" })).status).toBe(200);
  });

  it("limits how many uploads a user can start", async () => {
    const { session } = await signedInUser();
    const start = () =>
      session.rpc.files.createUpload({
        purpose: "avatar",
        filename: "x.png",
        contentType: "image/png",
        size: 10,
      });
    for (let i = 0; i < 30; i++) await start();
    await expectError(start(), "RATE_LIMITED");
  });

  it("reports files as on", async () => {
    const info = await createSession(harness).rpc.system.info();
    expect(info.features.files).toBe(true);
  });
});

describe("push devices", () => {
  const webDevice = (id = randomUUID()) => ({
    platform: "web" as const,
    subscription: {
      endpoint: `https://fcm.googleapis.com/fcm/send/${id}`,
      keys: { p256dh: `p256dh-${id}`, auth: `auth-${id}` },
    },
  });

  async function deviceRows(userId?: string) {
    const client = new pg.Client({ connectionString: harness.testDb.urlFor("postgres") });
    await client.connect();
    const { rows } = await client.query<{ user_id: string; platform: string; token: string }>(
      userId
        ? "SELECT user_id, platform, token FROM notifications.device WHERE user_id = $1"
        : "SELECT user_id, platform, token FROM notifications.device",
      userId ? [userId] : [],
    );
    await client.end();
    return rows;
  }

  it("tells browsers the VAPID public key to subscribe with", async () => {
    const info = await createSession(harness).rpc.system.info();
    expect(info.webPushPublicKey).toBe("BPublicVapidKeyForTests");
  });

  it("registers native and browser devices once, and removes them", async () => {
    const { session } = await signedInUser();
    const me = await session.rpc.user.me();
    const ios = { platform: "ios" as const, token: "a1".repeat(32) };
    const android = { platform: "android" as const, token: `fcm:${randomUUID()}` };
    const web = webDevice();

    const first = await session.rpc.notifications.registerDevice({
      device: ios,
      appVersion: "2.1.0",
    });
    // The app registers on every start: same token, same row.
    expect(await session.rpc.notifications.registerDevice({ device: ios })).toEqual(first);
    await session.rpc.notifications.registerDevice({ device: android });
    await session.rpc.notifications.registerDevice({ device: web });
    const rows = await deviceRows(me.id);
    expect(rows.map((row) => row.platform).sort()).toEqual(["android", "ios", "web"]);
    // Browser subscriptions are stored in one canonical form (key order fixed).
    expect(rows.find((row) => row.platform === "web")?.token).toBe(
      JSON.stringify({
        endpoint: web.subscription.endpoint,
        keys: { p256dh: web.subscription.keys.p256dh, auth: web.subscription.keys.auth },
      }),
    );

    await session.rpc.notifications.unregisterDevice({
      device: {
        ...web,
        subscription: { keys: web.subscription.keys, endpoint: web.subscription.endpoint },
      },
    });
    await session.rpc.notifications.unregisterDevice({ device: ios });
    expect((await deviceRows(me.id)).map((row) => row.platform)).toEqual(["android"]);
  });

  it("moves a device to whoever signs in on it, and one user can't remove another's", async () => {
    const device = { platform: "android" as const, token: `fcm:${randomUUID()}` };
    const first = await signedInUser();
    const second = await signedInUser();
    const firstId = (await first.session.rpc.user.me()).id;
    const secondId = (await second.session.rpc.user.me()).id;

    await first.session.rpc.notifications.registerDevice({ device });
    // Removing is scoped to the caller's own devices.
    await second.session.rpc.notifications.unregisterDevice({ device });
    expect((await deviceRows(firstId)).map((row) => row.token)).toEqual([device.token]);

    // The same phone, now signed in as someone else.
    await second.session.rpc.notifications.registerDevice({ device });
    expect(await deviceRows(firstId)).toEqual([]);
    expect((await deviceRows(secondId)).map((row) => row.token)).toEqual([device.token]);
  });

  it("keeps the 20 devices seen most recently", async () => {
    const { session } = await signedInUser();
    const me = await session.rpc.user.me();
    const tokens = Array.from({ length: 22 }, (_, i) => `fcm:${i}-${randomUUID()}`);
    for (const token of tokens) {
      await session.rpc.notifications.registerDevice({ device: { platform: "android", token } });
    }
    const kept = (await deviceRows(me.id)).map((row) => row.token).sort();
    expect(kept).toEqual(tokens.slice(2).sort());
  });

  it("rejects subscriptions that aren't a browser push service, and malformed tokens", async () => {
    const { session } = await signedInUser();
    for (const endpoint of [
      "https://169.254.169.254/latest/meta-data",
      "http://fcm.googleapis.com/fcm/send/x",
      "https://fcm.googleapis.com.attacker.dev/x",
      "https://localhost:3001/api/v1/system",
    ]) {
      await expectError(
        session.rpc.notifications.registerDevice({
          device: { platform: "web", subscription: { endpoint, keys: { p256dh: "k", auth: "a" } } },
        }),
        "VALIDATION_FAILED",
      );
    }
    await expectError(
      session.rpc.notifications.registerDevice({
        device: { platform: "ios", token: "../../3/device/evil" },
      }),
      "VALIDATION_FAILED",
    );
    await expectError(
      session.rpc.notifications.registerDevice({
        device: { platform: "android", token: "has spaces and / slashes" },
      }),
      "VALIDATION_FAILED",
    );
    expect(await deviceRows((await session.rpc.user.me()).id)).toEqual([]);
  });

  it("stops pushing to a device when its session signs out or is revoked", async () => {
    const { session: laptop, email, password } = await signedInUser();
    const me = await laptop.rpc.user.me();
    const phone = createSession(harness);
    await phone.auth("/sign-in/email", { email, password });
    const tablet = createSession(harness);
    await tablet.auth("/sign-in/email", { email, password });
    const token = (name: string) => `fcm:${name}-${me.id}`;
    await laptop.rpc.notifications.registerDevice({ device: webDevice() });
    await phone.rpc.notifications.registerDevice({
      device: { platform: "android", token: token("phone") },
    });
    await tablet.rpc.notifications.registerDevice({
      device: { platform: "android", token: token("tablet") },
    });
    expect(await deviceRows(me.id)).toHaveLength(3);

    await phone.auth("/sign-out");
    expect((await deviceRows(me.id)).map((row) => row.token)).not.toContain(token("phone"));

    // Revoked from the laptop: the tablet's device goes with its session.
    await laptop.auth("/revoke-other-sessions");
    expect((await deviceRows(me.id)).map((row) => row.platform)).toEqual(["web"]);
  });

  it("an admin impersonating the user can't register their own device", async () => {
    const { session } = await signedInUser();
    await editSession(harness, session, (stored) => {
      (stored as { impersonatedBy?: string }).impersonatedBy = randomUUID();
    });
    await expectError(
      session.rpc.notifications.registerDevice({ device: webDevice() }),
      "FORBIDDEN",
    );
  });

  it("requires a session", async () => {
    await expectError(
      createSession(harness).rpc.notifications.registerDevice({ device: webDevice() }),
      "UNAUTHENTICATED",
    );
  });

  it("the database function only registers for the user the transaction is scoped to", async () => {
    const client = new pg.Client({ connectionString: harness.testDb.urlFor("app_api") });
    await client.connect();
    await expect(
      client.query(
        "SELECT notifications.register_device('android', 'fcm:unscoped', null, gen_random_uuid())",
      ),
    ).rejects.toThrow(/app.user_id/);
    // Scoped to one user, with another user's session.
    const victim = await signedInUser();
    const attacker = await signedInUser();
    const [victimSession] = (
      await client.query<{ id: string }>("SELECT id FROM auth.session WHERE user_id = $1", [
        (await victim.session.rpc.user.me()).id,
      ])
    ).rows;
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.user_id', $1, true)", [
      (await attacker.session.rpc.user.me()).id,
    ]);
    await expect(
      client.query("SELECT notifications.register_device('android', 'fcm:stolen', null, $1)", [
        victimSession?.id,
      ]),
    ).rejects.toThrow(/is not the user's/);
    await client.query("ROLLBACK");
    await client.end();
    const notifications = new pg.Client({
      connectionString: harness.testDb.urlFor("app_notifications"),
    });
    await notifications.connect();
    await expect(
      notifications.query(
        "SELECT notifications.register_device('android', 'fcm:x', null, gen_random_uuid())",
      ),
    ).rejects.toThrow(/permission denied/);
    await notifications.end();
  });
});

describe("account deletion", () => {
  /** Counts an organization's todos and reports whether the org still exists (as the migrator). */
  async function orgState(orgId: string) {
    const client = new pg.Client({ connectionString: harness.testDb.urlFor("migrator") });
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
      const todos = await client.query<{ count: string; created: string }>(
        "SELECT count(*) AS count, count(created_by_id) AS created FROM app.todo",
      );
      const org = await client.query("SELECT 1 FROM auth.organization WHERE id = $1", [orgId]);
      await client.query("COMMIT");
      return {
        exists: org.rowCount === 1,
        todos: Number(todos.rows[0]?.count),
        withCreator: Number(todos.rows[0]?.created),
      };
    } finally {
      await client.end();
    }
  }

  it("removes the personal workspace and its data", async () => {
    const { session, password } = await signedInUser();
    await session.rpc.todo.create({ title: "Private" });
    const orgId = (await session.rpc.user.me()).activeOrganizationId as string;
    expect(await orgState(orgId)).toMatchObject({ exists: true, todos: 1 });

    expect((await session.auth("/delete-user", { password })).status).toBe(200);
    expect(await orgState(orgId)).toEqual({ exists: false, todos: 0, withCreator: 0 });
  });

  it("won't leave a shared workspace without an owner, and keeps its data", async () => {
    const owner = await signedInUser();
    const member = await signedInUser();
    const team = await owner.session.auth<{ id: string }>("/organization/create", {
      name: "Team",
      slug: `team-${randomUUID().slice(0, 8)}`,
    });
    await owner.session.auth("/organization/invite-member", {
      email: member.email,
      role: "member",
      organizationId: team.body.id,
    });
    const invitation = await takeNotification(harness, "org.invitation", member.email);
    const invitationId = new URL(invitation.data.acceptUrl).pathname.split("/").at(-1);
    expect(
      (await member.session.auth("/organization/accept-invitation", { invitationId })).status,
    ).toBe(200);
    await owner.session.auth("/organization/set-active", { organizationId: team.body.id });
    await owner.session.rpc.todo.create({ title: "Team work" });

    const blocked = await owner.session.auth<{ code: string }>("/delete-user", {
      password: owner.password,
    });
    expect(blocked.status).toBe(400);
    expect(blocked.body.code).toBe("ORGANIZATION_NEEDS_OWNER");

    const { id: memberUserId } = await member.session.rpc.user.me();
    const { members } = await owner.session.authGet<{ members: { id: string; userId: string }[] }>(
      `/organization/list-members?organizationId=${team.body.id}`,
    );
    const target = members.find((m) => m.userId === memberUserId)?.id;
    expect(
      (
        await owner.session.auth("/organization/update-member-role", {
          memberId: target,
          role: "owner",
          organizationId: team.body.id,
        })
      ).status,
    ).toBe(200);

    expect((await owner.session.auth("/delete-user", { password: owner.password })).status).toBe(
      200,
    );
    // The team and its todo survive; the todo just no longer names its creator.
    expect(await orgState(team.body.id)).toEqual({ exists: true, todos: 1, withCreator: 0 });
  });
});

describe("todos", () => {
  it("creates, pages, completes and deletes, with typed errors", async () => {
    const { session } = await signedInUser();
    const created = [];
    for (const title of ["one", "two", "three"])
      created.push(await session.rpc.todo.create({ title }));
    expect(created[0]?.createdAt).toBeInstanceOf(Date);

    const first = await session.rpc.todo.list({ limit: 2 });
    expect(first.items.map((todo) => todo.title)).toEqual(["three", "two"]);
    expect(first.nextCursor).toBeTruthy();
    const second = await session.rpc.todo.list({ limit: 2, cursor: first.nextCursor ?? undefined });
    expect(second.items.map((todo) => todo.title)).toEqual(["one"]);
    expect(second.nextCursor).toBeNull();

    const todo = created[0];
    if (!todo) throw new Error("no todo");
    const done = await session.rpc.todo.setCompleted({
      id: todo.id,
      completed: true,
      version: todo.version,
    });
    expect(done).toMatchObject({ completed: true, version: todo.version + 1 });
    // A second writer holding the old version is told, instead of silently overwriting.
    await expectError(
      session.rpc.todo.setCompleted({ id: todo.id, completed: false, version: todo.version }),
      "TODO_VERSION_CONFLICT",
    );

    await session.rpc.todo.delete({ id: todo.id });
    await expectError(session.rpc.todo.delete({ id: todo.id }), "TODO_NOT_FOUND");
  });

  it("returns validation problems as codes, never English messages", async () => {
    const { session } = await signedInUser();
    const error = await expectError(session.rpc.todo.create({ title: "   " }), "VALIDATION_FAILED");
    expect(error.data.issues).toEqual([{ path: ["title"], code: "too_small" }]);
  });

  it("keeps organizations apart", async () => {
    const alice = (await signedInUser()).session;
    const bob = (await signedInUser()).session;
    const secret = await alice.rpc.todo.create({ title: "alice's plan" });

    expect((await bob.rpc.todo.list({ limit: 20 })).items).toEqual([]);
    await expectError(bob.rpc.todo.delete({ id: secret.id }), "TODO_NOT_FOUND");
    await expectError(
      bob.rpc.todo.setCompleted({ id: secret.id, completed: true, version: 1 }),
      "TODO_NOT_FOUND",
    );
    expect((await alice.rpc.todo.list({ limit: 20 })).items).toHaveLength(1);
  });

  it("records a domain event in the same transaction as each change", async () => {
    const { session } = await signedInUser();
    const todo = await session.rpc.todo.create({ title: "evented" });
    const { createDb } = await import("@repo/db");
    const migrator = createDb({
      url: harness.testDb.urlFor("migrator"),
      poolMax: 1,
      service: "test",
    });
    const events = await migrator.appOutboxEvent.findMany({ where: { key: todo.id } });
    await migrator.$disconnect();
    expect(events.map((event) => event.name)).toEqual(["todo.created.v1"]);
    expect(events[0]?.requestId).toBeTruthy();
  });
});

describe("clients", () => {
  it("tells outdated apps to update", async () => {
    const outdated = createSession(harness, { appVersion: "1.9.0" });
    await expectError(outdated.rpc.system.info(), "CLIENT_OUTDATED");
    const current = createSession(harness, { appVersion: "2.0.0" });
    await expect(current.rpc.system.info()).resolves.toMatchObject({
      minimumClientVersion: "2.0.0",
    });
  });
});
