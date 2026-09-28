/**
 * The API's security and behaviour guarantees, against the real app, database and Redis.
 */
import { ORPCError } from "@orpc/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSession, type Harness, newEmail, newPassword, startApi, takeOtp } from "./harness";

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
