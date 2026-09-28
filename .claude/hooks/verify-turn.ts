/**
 * Stop: if this turn changed files, run the fast checks for affected packages (lint,
 * types, unit tests) and send Claude back to fix failures. Guard rails:
 * - skipped when nothing changed since the prompt (see turn-start.ts)
 * - capped at 60 seconds; a timeout is reported, not treated as failure
 * - blocks at most once per stop (`stop_hook_active`), so it can never loop
 * Integration and e2e tests are not run here: they need Docker and minutes; use the
 * `verify` skill, and CI runs everything.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { ROOT, readInput, respond, STATE_DIR } from "./lib";

const input = await readInput();
if (input.stop_hook_active) process.exit(0);

const snapshotFile = join(STATE_DIR, `turn-${input.session_id}.txt`);
const now =
  (await $`git status --porcelain=v1 -uall`.cwd(ROOT).quiet().nothrow().text()) +
  (await $`git diff --stat HEAD`.cwd(ROOT).quiet().nothrow().text());
if (existsSync(snapshotFile) && readFileSync(snapshotFile, "utf8") === now) process.exit(0);

const run = Bun.spawn(
  [
    "bunx",
    "turbo",
    "run",
    "lint",
    "check-types",
    "test",
    "--affected",
    "--output-logs=errors-only",
  ],
  {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  },
);
const timer = setTimeout(() => run.kill(), 60_000);
const [code, out, err] = await Promise.all([
  run.exited,
  new Response(run.stdout).text(),
  new Response(run.stderr).text(),
]);
clearTimeout(timer);

if (run.signalCode) {
  respond({
    systemMessage:
      "Fast checks exceeded 60s and were skipped. Run `bun run check-types && bun run test` before finishing.",
  });
}
if (code !== 0) {
  const log = `${out}\n${err}`.trim().split("\n").slice(-60).join("\n");
  respond({
    decision: "block",
    reason: `Checks failed for the packages you changed. Fix these before finishing (or explain why they are unrelated):\n\n${log}`,
  });
}
