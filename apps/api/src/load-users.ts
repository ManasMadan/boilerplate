/**
 * Signed-in users for the load tests (load/): `bun run --cwd apps/api load:users`.
 *
 * Creates LOAD_USERS verified users (load-<n>@load.test, each with a personal workspace,
 * like any sign-up), signs each one in and writes their session cookies to
 * load/.sessions.json for k6. Sign-in is rate limited per IP by design, so a load test
 * can't sign in hundreds of virtual users itself; this signs them in through the app's
 * own auth configuration instead, once, the way a real session is made. Running it again
 * reuses the users and mints fresh sessions. Refuses to run in production.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DATABASE, type Database } from "@repo/nest-common";
import { z } from "zod";
import { AUTH, type Auth } from "./auth/auth.module";
import { env } from "./env";
import { createApiServer } from "./server";

if (env.NODE_ENV === "production") {
  console.error("Load-test users are for development and test environments only.");
  process.exit(1);
}

const count = z.coerce.number().int().min(1).max(1_000).default(50).parse(process.env.LOAD_USERS);
const output = join(import.meta.dirname, "..", "..", "..", "load", ".sessions.json");
// Only for these throwaway accounts; the sessions file is what k6 uses.
const PASSWORD = "load-test-password-not-secret";

const app = await createApiServer();
await app.init();
try {
  const auth = app.get<Auth>(AUTH);
  const database = app.get<Database>(DATABASE);
  const sessions: string[] = [];
  for (let n = 1; n <= count; n++) {
    const email = `load-${n}@load.test`;
    if (!(await database.write.user.findUnique({ where: { email } }))) {
      const { user } = await auth.api.signUpEmail({
        body: { name: `Load ${n}`, email, password: PASSWORD, locale: "en", timezone: "UTC" },
      });
      await database.write.user.update({ where: { id: user.id }, data: { emailVerified: true } });
    }
    const response = await auth.api.signInEmail({
      body: { email, password: PASSWORD },
      asResponse: true,
    });
    const cookie = response.headers
      .getSetCookie()
      .map((header) => header.split(";")[0] ?? "")
      .find((pair) => pair.includes("session_token="));
    if (!response.ok || !cookie) throw new Error(`Signing in ${email} failed (${response.status})`);
    sessions.push(cookie);
  }
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(sessions, null, 2)}\n`);
  console.log(`${count} signed-in users written to ${output}`);
} finally {
  await app.close();
}
