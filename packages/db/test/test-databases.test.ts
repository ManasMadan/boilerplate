/** Test databases left behind by a run that died are dropped by the next run. */
import { spawnSync } from "node:child_process";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, dropAbandonedTestDatabases } from "../src/testing";

const admin = () => {
  const url = new URL(process.env.MIGRATOR_DATABASE_URL ?? "");
  url.pathname = "/postgres";
  return new pg.Client({ connectionString: url.toString() });
};
let client: pg.Client;
const exists = async (name: string) =>
  (await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [name])).rowCount === 1;

beforeAll(async () => {
  client = admin();
  await client.connect();
});
afterAll(async () => {
  await client.end();
});

describe("abandoned test databases", () => {
  it("are dropped once their process is gone; a running process's stay", async () => {
    // The pid of a process that has exited.
    const gone = spawnSync("true").pid;
    const abandoned = `app_test_${gone}_0123456789ab`;
    await client.query(`CREATE DATABASE ${abandoned}`);
    const live = await createTestDatabase();
    try {
      await dropAbandonedTestDatabases();
      expect(await exists(abandoned)).toBe(false);
      expect(await exists(live.name)).toBe(true);
      expect(await exists("app_test")).toBe(true);
    } finally {
      await live.drop();
      await client.query(`DROP DATABASE IF EXISTS ${abandoned}`);
    }
  });
});

describe("dropping a test database", () => {
  it("waits for a service's connection that's closing", async () => {
    const testDb = await createTestDatabase();
    const service = new pg.Client({ connectionString: testDb.urlFor("app_api") });
    await service.connect();
    // FORCE can't end another role's session: without the wait this drop fails. The
    // delay is on purpose: the connection closes while the drop is already waiting.
    const closing = new Promise((resolve) => setTimeout(resolve, 300)).then(() => service.end());
    await testDb.drop();
    await closing;
    expect(await exists(testDb.name)).toBe(false);
  });

  it("names a connection a test left open", async () => {
    const testDb = await createTestDatabase();
    const leak = new pg.Client({ connectionString: testDb.urlFor("app_api") });
    const named = new pg.Client({
      connectionString: testDb.urlFor("app_worker"),
      application_name: "leaky-service",
    });
    await Promise.all([leak.connect(), named.connect()]);
    try {
      const drop = testDb.drop(200);
      await expect(drop).rejects.toThrow(/connections still open: .*app_api \(pid \d+\)/);
      await expect(drop).rejects.toThrow(/app_worker \(pid \d+, leaky-service\)/);
    } finally {
      await Promise.all([leak.end(), named.end()]);
      await testDb.drop();
    }
  });
});
