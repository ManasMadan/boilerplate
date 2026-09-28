/**
 * The web app renders UI only; all backend logic lives in apps/api. Next.js makes it
 * easy to slip server code in anyway (route handlers, server actions), so CI fails on
 * either. The one allowed route handler is the Kubernetes health probe.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";
import { fail, ok, ROOT } from "./lib";

const WEB = join(ROOT, "apps/web/src");
const ALLOWED_ROUTES = new Set(["app/healthz/route.ts"]);
let violations = 0;

for (const file of new Glob("app/**/route.{ts,tsx}").scanSync(WEB)) {
  if (!ALLOWED_ROUTES.has(file)) {
    violations += 1;
    fail(
      `apps/web/src/${file}: route handlers are not allowed; add an API procedure in apps/api instead.`,
    );
  }
}

for (const file of new Glob("**/*.{ts,tsx}").scanSync(WEB)) {
  const source = readFileSync(join(WEB, file), "utf8");
  if (/^\s*["']use server["']/m.test(source)) {
    violations += 1;
    fail(
      `apps/web/src/${file}: server actions ("use server") are not allowed; call the API instead.`,
    );
  }
}

for (const file of new Glob("pages/api/**/*").scanSync(WEB)) {
  violations += 1;
  fail(`apps/web/src/${file}: Pages Router API routes are not allowed.`);
}

if (violations) process.exit(1);
ok("web app is render-only");
