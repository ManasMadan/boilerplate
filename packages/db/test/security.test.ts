/**
 * Proves the database enforces tenancy and least privilege by itself, independent of
 * application code: run as the real service roles against a fresh migrated database.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db, tenantTx, withTenant } from "../src";
import { createTestDatabase, type TestDatabase } from "../src/testing";

let testDb: TestDatabase;
let api: Db;
const orgA = randomUUID();
const orgB = randomUUID();
const userId = randomUUID();

async function asRole<T>(role: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: testDb.urlFor(role) });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  api = createDb({ url: testDb.urlFor("app_api"), poolMax: 5, service: "test" });
  // Tenant rows reference real organizations and users (foreign keys).
  await api.user.create({ data: { id: userId, name: "Owner", email: `${userId}@test.dev` } });
  for (const id of [orgA, orgB])
    await api.organization.create({ data: { id, name: id, slug: id } });
  await tenantTx(api, orgA, (tx) =>
    tx.todo.create({ data: { orgId: orgA, createdById: userId, title: "A1" } }),
  );
  await tenantTx(api, orgB, (tx) =>
    tx.todo.create({ data: { orgId: orgB, createdById: userId, title: "B1" } }),
  );
});

afterAll(async () => {
  await api?.$disconnect();
  await testDb?.drop();
});

describe("row-level security", () => {
  it("shows a tenant only its own rows", async () => {
    const rows = await withTenant(api, orgA).todo.findMany();
    expect(rows.map((row) => row.title)).toEqual(["A1"]);
  });

  it("shows nothing when no tenant is set", async () => {
    expect(await api.todo.count()).toBe(0);
  });

  it("rejects writing a row into another tenant", async () => {
    await expect(
      withTenant(api, orgA).todo.create({
        data: { orgId: orgB, createdById: userId, title: "sneaky" },
      }),
    ).rejects.toThrow();
  });

  it("cannot update or delete another tenant's rows", async () => {
    const tenant = withTenant(api, orgA);
    expect(
      (await tenant.todo.updateMany({ where: { orgId: orgB }, data: { completed: true } })).count,
    ).toBe(0);
    expect((await tenant.todo.deleteMany({ where: { orgId: orgB } })).count).toBe(0);
  });

  it("blocks nested transactions on a tenant client, which would not be atomic", () => {
    const tenant = withTenant(api, orgA);
    // The type allows no arguments (so real calls don't compile); the runtime also throws.
    expect(() => tenant.$transaction()).toThrow(/tenantTx/);
  });

  it("never leaks across tenants under concurrent pooled requests", async () => {
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) => {
        const org = i % 2 === 0 ? orgA : orgB;
        return withTenant(api, org)
          .todo.findMany()
          .then((rows) => rows.every((row) => row.orgId === org));
      }),
    );
    expect(results.every(Boolean)).toBe(true);
  });

  it("keeps the policy forced on every tenant table (drift checks cannot see this)", async () => {
    const tables = await asRole("migrator", async (client) => {
      const { rows } = await client.query<{ table: string; forced: boolean; policies: number }>(`
        SELECT c.relname AS table, c.relforcerowsecurity AS forced,
               (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = n.nspname AND p.tablename = c.relname) AS policies
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN information_schema.columns col ON col.table_schema = n.nspname AND col.table_name = c.relname
        WHERE col.column_name = 'org_id' AND c.relkind = 'r' AND c.relname <> 'outbox_event'`);
      return rows;
    });
    expect(tables.length).toBeGreaterThan(0);
    for (const table of tables) {
      expect(table, `${table.table} must FORCE row-level security with a policy`).toMatchObject({
        forced: true,
      });
      expect(table.policies).toBeGreaterThan(0);
    }
  });
});

describe("least privilege", () => {
  it("lets notifications read identity columns only", async () => {
    await asRole("app_notifications", async (client) => {
      await expect(
        client.query(`SELECT id, email, locale, timezone FROM auth."user"`),
      ).resolves.toBeDefined();
      await expect(client.query(`SELECT email_verified FROM auth."user"`)).rejects.toThrow(
        /permission denied/,
      );
      await expect(client.query("SELECT * FROM auth.account")).rejects.toThrow(/permission denied/);
      await expect(client.query("SELECT * FROM app.todo")).rejects.toThrow(/permission denied/);
    });
  });

  it("lets the worker only stamp outbox events as published", async () => {
    await asRole("app_worker", async (client) => {
      await expect(
        client.query("UPDATE app.outbox_event SET published_at = now() WHERE false"),
      ).resolves.toBeDefined();
      await expect(
        client.query("UPDATE app.outbox_event SET payload = '{}' WHERE false"),
      ).rejects.toThrow(/permission denied/);
      await expect(client.query("DELETE FROM app.outbox_event WHERE false")).rejects.toThrow(
        /permission denied/,
      );
      await expect(client.query("SELECT * FROM app.todo")).rejects.toThrow(/permission denied/);
    });
  });

  it("denies schema changes to service roles", async () => {
    await asRole("app_api", async (client) => {
      await expect(client.query("CREATE TABLE app.nope (id int)")).rejects.toThrow(
        /permission denied/,
      );
      await expect(client.query("ALTER TABLE app.todo DISABLE ROW LEVEL SECURITY")).rejects.toThrow(
        /must be owner/,
      );
    });
  });
});
