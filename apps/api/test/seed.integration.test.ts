/** The demo seed (bun run db:seed) leaves what using the app would, and only once. */
import { DATABASE, type Database } from "@repo/nest-common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Auth } from "../src/auth/auth.module";
import { DEMO_PASSWORD, DEMO_PEOPLE, seedDemo } from "../src/seed/demo";
import { loadEmail, signInLoadUsers } from "../src/seed/load-users";
import { createSession, type Harness, startApi } from "./harness";

let harness: Harness;
let seed: () => ReturnType<typeof seedDemo>;
beforeAll(async () => {
  harness = await startApi(2);
  // Imported only now: these load the API's configuration, which startApi points at
  // this file's own database first.
  const { AUTH } = await import("../src/auth/auth.module");
  const { TodoService } = await import("../src/modules/todo");
  seed = () =>
    seedDemo({
      auth: harness.app.get<Auth>(AUTH),
      database: harness.app.get<Database>(DATABASE),
      todos: harness.app.get(TodoService),
    });
});
afterAll(() => harness?.close());

describe("demo seed", () => {
  it("creates verified users who can sign in and see their workspaces' todos", async () => {
    const created = await seed();
    expect(created).not.toBeNull();

    const session = createSession(harness);
    const signIn = await session.auth("/sign-in/email", {
      email: DEMO_PEOPLE[0].email,
      password: DEMO_PASSWORD,
    });
    expect(signIn.status).toBe(200);
    const personal = await session.rpc.todo.list({});
    expect(personal.items.map((todo) => todo.title).sort()).toEqual([
      "Connect an app",
      "Invite a teammate",
      "Try the assistant",
    ]);

    await session.auth("/organization/set-active", { organizationId: created?.teamId });
    const team = await session.rpc.todo.list({});
    expect(team.items.map((todo) => [todo.title, todo.completed]).sort()).toEqual([
      ["Plan the launch", false],
      ["Set up billing", true],
      ["Write the changelog", false],
    ]);
  });

  it("changes nothing when run again", async () => {
    expect(await seed()).toBeNull();
    const database = harness.app.get<Database>(DATABASE);
    expect(
      await database.write.user.count({ where: { email: { endsWith: "@example.com" } } }),
    ).toBe(2);
  });
});

describe("load-test users", () => {
  const signIn = (count: number) =>
    signInLoadUsers(
      { auth: harness.app.get<Auth>(AUTH), database: harness.app.get<Database>(DATABASE) },
      count,
    );
  let AUTH: symbol;
  beforeAll(async () => {
    ({ AUTH } = await import("../src/auth/auth.module"));
  });

  it("signs in verified users with their own workspace, reusing them on the next run", async () => {
    const first = await signIn(3);
    expect(first).toHaveLength(3);
    for (const cookie of first) {
      const response = await fetch(`${harness.baseUrl}/api/v1/todos`, { headers: { cookie } });
      expect(response.status).toBe(200);
    }
    const again = await signIn(3);
    expect(again).toHaveLength(3);
    expect(again).not.toEqual(first);
    const users = await harness.app
      .get<Database>(DATABASE)
      .write.user.findMany({ where: { email: { in: [1, 2, 3].map(loadEmail) } } });
    expect(users.map((user) => user.emailVerified)).toEqual([true, true, true]);
  });
});
