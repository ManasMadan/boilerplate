/**
 * PreToolUse (Edit|Write|MultiEdit|NotebookEdit): refuse edits that would be lost or
 * dangerous, and ask the user about changes to Claude's own guard rails (file-rules.ts).
 * It fails closed: an event it can't read blocks the edit. Runs in well under 100ms.
 */
import { spawnSync } from "node:child_process";
import { verdictFor } from "./file-rules";
import { defaultBranch, editedText, ROOT, readInput, respond, targetPath } from "./lib";

const input = await readInput({ failClosed: true });
const path = targetPath(input);
if (!path) process.exit(0);

const branch = await defaultBranch();
const shipped =
  spawnSync("git", ["cat-file", "-e", `${branch}:${path}`], { cwd: ROOT }).status === 0;
const verdict = verdictFor({ path, shipped, ...editedText(input) });
if (verdict) {
  respond({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: verdict.decision,
      permissionDecisionReason: verdict.reason,
    },
  });
}
