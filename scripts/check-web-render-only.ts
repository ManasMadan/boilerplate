/**
 * The web app renders UI only; all backend logic lives in apps/api. Next.js makes it
 * easy to slip server code in anyway (route handlers, server actions), so CI fails on
 * either. The one allowed route handler is the Kubernetes health probe.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";
import { fail, ok, ROOT } from "./lib";

const ALLOWED_ROUTES = new Set(["app/healthz/route.ts"]);

/** Reports each piece of server code in the web app's source at `web`; the exit code. */
export function checkWebRenderOnly(web = join(ROOT, "apps/web/src")): number {
  let violations = 0;

  for (const file of new Glob("app/**/route.{ts,tsx}").scanSync(web)) {
    if (!ALLOWED_ROUTES.has(file)) {
      violations += 1;
      fail(
        `apps/web/src/${file}: route handlers are not allowed; add an API procedure in apps/api instead.`,
      );
    }
  }

  for (const file of new Glob("**/*.{ts,tsx}").scanSync(web)) {
    const source = readFileSync(join(web, file), "utf8");
    if (/^\s*["']use server["']/m.test(source)) {
      violations += 1;
      fail(
        `apps/web/src/${file}: server actions ("use server") are not allowed; call the API instead.`,
      );
    }
  }

  for (const file of new Glob("pages/api/**/*").scanSync(web)) {
    violations += 1;
    fail(`apps/web/src/${file}: Pages Router API routes are not allowed.`);
  }

  if (violations) {
    return 1;
  }
  ok("web app is render-only");
  return 0;
}

if (import.meta.main) {
  process.exit(checkWebRenderOnly());
}
