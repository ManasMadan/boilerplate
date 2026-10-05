/**
 * Before a push leaves the machine: every file it can affect at 100%, across every suite,
 * as CI checks on the pull request. The packages its commits change and every package
 * that depends on them (turbo's `...[base]`) run their whole coverage suite (unit,
 * integration, browser, mobile, Python), the scripts and hooks run theirs, and
 * scripts/coverage.ts checks each file under those folders.
 *
 *   bun scripts/push-coverage.ts      (the pre-push hook runs this)
 *
 * It needs Docker: it starts the core services and RustFS. ClamAV comes from the
 * stand-in in @repo/testing/fake-clamd unless it's running. A push that changes shared
 * code (contracts, nest-common) runs most suites, so it takes a while; one that changes a
 * single app runs that app's.
 */
import * as z from "zod";
import { fail, ok, ROOT, type Run, runSync } from "./lib";
import { pushBase } from "./unit-coverage";

const turboList = z.object({
  packages: z.object({ items: z.array(z.object({ path: z.string() })) }),
});

/** The folders of the packages a push from `base` changes, and of everything depending on them. */
export function affected(base: string, run: Run, root = ROOT): string[] {
  const listed = run("bunx", ["turbo", "ls", `--filter=...[${base}]`, "--output=json"], {
    cwd: root,
  });
  if (listed.status !== 0) throw new Error(`turbo ls failed: ${listed.stderr.trim()}`);
  return turboList.parse(JSON.parse(listed.stdout)).packages.items.map((item) => item.path);
}

/** Starts what the suites need; false when Docker isn't running. */
function services(run: Run, root: string) {
  if (run("docker", ["info"], { cwd: root }).status !== 0) {
    fail("Docker isn't running: start it, since the push runs every suite of what it changes.");
    return false;
  }
  const inherit = { cwd: root, stdio: "inherit" } as const;
  return (
    run("bun", ["scripts/services.ts", "up"], inherit).status === 0 &&
    run("docker", ["compose", "--profile", "files", "up", "-d", "--wait", "rustfs"], inherit)
      .status === 0
  );
}

/** The check; the exit code. */
export function pushCoverage({ run = runSync, root = ROOT } = {}): number {
  const base = pushBase((args) => run("git", args, { cwd: root }).stdout);
  const packages = affected(base, run, root);
  const inherit = { cwd: root, stdio: "inherit" } as const;
  if (packages.length > 0) {
    if (!services(run, root)) return 1;
    // Two at a time: the integration suites share the services, and a busy machine makes
    // timing-sensitive tests flaky.
    const suites = run(
      "bunx",
      ["turbo", "run", "coverage", `--filter=...[${base}]`, "--concurrency=2"],
      inherit,
    );
    if (suites.status !== 0) {
      fail("tests failed");
      return 1;
    }
  }
  const scripts = run("bun", ["test", "--coverage", "./scripts/", "./.claude/hooks/"], inherit);
  if (scripts.status !== 0) {
    fail("the scripts' or hooks' tests failed, or left a file below 100%");
    return 1;
  }
  const checked = run(
    "bun",
    ["scripts/coverage.ts", ...packages, "scripts", ".claude/hooks"],
    inherit,
  );
  if (checked.status !== 0) return 1;
  ok(`every file in ${packages.length} package(s), the scripts and the hooks at 100%`);
  return 0;
}

if (import.meta.main) process.exit(pushCoverage());
