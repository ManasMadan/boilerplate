/**
 * The API's security and behaviour guarantees, against the real app, database and Redis.
 */
import { randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/client";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSession,
  editSession,
  expireOtps,
  type Harness,
  newEmail,
  newPassword,
  startApi,
  takeNotification,
  takeOtp,
} from "./harness";

let harness: Harness;

beforeAll(async () => {
  harness = await startApi({ MINIMUM_CLIENT_VERSION: "2.0.0" });
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

describe("sign-up and verification", () => {
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
});

describe("account security", () => {
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
