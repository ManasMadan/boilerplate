/**
 * Isolated databases for integration tests.
 *
 *   // vitest globalSetup: migrate the template once per run
 *   await prepareTemplate();
 *   // each test file: its own copy, created in milliseconds from the template
 *   const testDb = await createTestDatabase();
 *   const db = createDb({ url: testDb.urlFor("app_api"), poolMax: 5, service: "test" });
 *   ...
 *   await testDb.drop();
 *
 * Tests connect as the same least-privileged roles the services use, so missing grants
 * and row-level-security mistakes fail in tests, not in production.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import pg from "pg";

const DB_PACKAGE = join(import.meta.dirname, "../..");
const TEMPLATE = "app_test";

/** Local role passwords match the role names (infra/postgres/init). */
const ROLE_PASSWORDS: Record<string, string> = {
  migrator: "migrator",
  app_api: "app_api",
  app_worker: "app_worker",
  app_notifications: "app_notifications",
  app_webhooks: "app_webhooks",
  app_ai: "app_ai",
};
const SERVICE_ROLES = Object.keys(ROLE_PASSWORDS).filter((role) => role !== "migrator");

function serverUrl() {
  const url = process.env.MIGRATOR_DATABASE_URL;
  if (!url)
    throw new Error("MIGRATOR_DATABASE_URL must be set for integration tests (see .env.example).");
  return new URL(url);
}

function urlFor(database: string, role: string) {
  const url = serverUrl();
  url.username = role;
  url.password = ROLE_PASSWORDS[role] ?? role;
  url.pathname = `/${database}`;
  return url.toString();
}

/** Applies all migrations to the template database. Call once per test run. */
export async function prepareTemplate() {
  execFileSync("bunx", ["prisma", "migrate", "deploy"], {
    cwd: DB_PACKAGE,
    env: { ...process.env, MIGRATOR_DATABASE_URL: urlFor(TEMPLATE, "migrator") },
    stdio: "pipe",
  });
}

export interface TestDatabase {
  name: string;
  urlFor(role: string): string;
  drop(): Promise<void>;
}

/** Clones the migrated template into a fresh database for one test file. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `app_test_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const admin = new pg.Client({ connectionString: urlFor("postgres", "migrator") });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE}`);
    // Database-level privileges are not copied from the template.
    await admin.query(`REVOKE ALL ON DATABASE ${name} FROM PUBLIC`);
    await admin.query(`GRANT CONNECT ON DATABASE ${name} TO ${SERVICE_ROLES.join(", ")}`);
  } finally {
    await admin.end();
  }
  return {
    name,
    urlFor: (role) => urlFor(name, role),
    async drop() {
      const client = new pg.Client({ connectionString: urlFor("postgres", "migrator") });
      await client.connect();
      try {
        await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await client.end();
      }
    },
  };
}
