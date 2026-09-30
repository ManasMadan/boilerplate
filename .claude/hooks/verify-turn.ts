/**
 * Stop: if this turn changed files, run the fast checks on what changed (checks.ts:
 * Biome on the changed files; lint, types and unit tests of the affected packages; types
 * and tests of scripts/ and the hooks when they changed, which turbo can't see; knip)
 * and send Claude back to fix what fails. Guard rails:
 * - skipped when the working tree's content is what it was at the prompt (turn-start.ts);
 * - capped at 60 seconds: a timeout tells Claude which checks didn't run and blocks until
 *   it has run them, so a slow check is never a silent pass;
 * - re-checks after every fix, up to 3 times a turn, so a fix is verified too and a stuck
 *   turn can't loop forever (the user is told when the cap is reached);
 * - asks for the full checks once per state of the tree: after Claude has run them, the
 *   same unchanged tree isn't asked about again.
 * Integration and e2e tests need Docker and minutes: the verify skill and CI run those.
 */

import { existsSync, readFileSync } from "node:fs";
import { checksFor, touchesEverything } from "./checks";
import {
  askedFile,
  changedFiles,
  defaultBranch,
  ROOT,
  readInput,
  respond,
  stopCountFile,
  treeFingerprint,
  turnFile,
} from "./lib";

const BUDGET_MS = 60_000;
const MAX_RECHECKS = 3;

const input = await readInput();
const start = turnFile(input.session_id);
if (existsSync(start) && readFileSync(start, "utf8") === (await treeFingerprint())) process.exit(0);

const countFile = stopCountFile(input.session_id);
const count = existsSync(countFile) ? Number(readFileSync(countFile, "utf8")) : 0;
if (input.stop_hook_active && count >= MAX_RECHECKS) {
  respond({
    systemMessage: `The fast checks still fail after ${MAX_RECHECKS} fixes this turn; stopping so you can look.`,
  });
}

const changed = await changedFiles();
const checks = checksFor(changed);
const deadline = AbortSignal.timeout(BUDGET_MS);
const results = await Promise.all(
  checks.map(async (check) => {
    const run = Bun.spawn(check.command, {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
      signal: deadline,
    });
    const [code, out, err] = await Promise.all([
      run.exited,
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
    ]);
    return { check, code, timedOut: run.signalCode !== null, log: `${out}\n${err}`.trim() };
  }),
);

const block = async (reason: string) => {
  await Bun.write(countFile, String(count + 1));
  respond({ decision: "block", reason });
};
const failed = results.filter((result) => result.code !== 0 && !result.timedOut);
const unfinished = results.filter((result) => result.timedOut).map((result) => result.check);
if (failed.length) {
  const logs = failed
    .map((result) => `## ${result.check.label}\n${result.log.split("\n").slice(-40).join("\n")}`)
    .join("\n\n");
  await block(
    `Checks failed on what you changed. Fix them before finishing. If a failure isn't from this change, show it: run the same command on a clean checkout of ${await defaultBranch()} (a git worktree) and show it fails there too.\n\n${logs}`,
  );
}
const asked = askedFile(input.session_id);
const fingerprint = await treeFingerprint();
const askedAlready = existsSync(asked) && readFileSync(asked, "utf8") === fingerprint;
if ((unfinished.length || touchesEverything(changed)) && !askedAlready) {
  await Bun.write(asked, fingerprint);
  const commands = unfinished.length
    ? unfinished.map((check) => `\`${check.command.join(" ")}\``).join(", ")
    : "`bun run check-types` and `bun run test`";
  await block(
    `The fast checks couldn't cover this change in ${BUDGET_MS / 1000} s${touchesEverything(changed) ? " (it touches what every package depends on)" : ""}. Run ${commands} in the background (run_in_background), fix what fails, and only then finish.`,
  );
}
