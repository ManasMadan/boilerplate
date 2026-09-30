/**
 * PostToolUse (Edit|Write|MultiEdit): refuses a new suppression, skipped or focused test,
 * or coverage pragma (scripts/suppressions.ts) in code, unless docs/testing.md lists the
 * file in its exceptions tables. The edit has happened, so Claude is told to undo it.
 */
import { spawnSync } from "node:child_process";
import { addedSuppressions, CODE, DEFINES_THEM, listedFiles } from "../../scripts/suppressions";
import { editedText, ROOT, readInput, respond, targetPath } from "./lib";

const input = await readInput();
const path = targetPath(input);
if (!path || !CODE.test(path) || DEFINES_THEM.has(path)) process.exit(0);

const edit = editedText(input);
// A whole-file write replaces what the last commit had.
const before =
  input.tool_name === "Write"
    ? (spawnSync("git", ["show", `HEAD:${path}`], { cwd: ROOT, encoding: "utf8" }).stdout ?? "")
    : (edit.before ?? "");
const added = addedSuppressions(before, edit.after ?? "");
if (added.length && !listedFiles(ROOT).has(path)) {
  respond({
    decision: "block",
    reason: `${path} now has ${added.join(", ")}. Fix the cause instead and remove it. If it truly can't be fixed, the user decides: it's allowed only with a row in docs/testing.md's exceptions tables (the reason, and the test that covers the behaviour another way).`,
  });
}
