/**
 * PreToolUse (Bash): the same file rules as guard-files.ts for files a command writes
 * (sed -i, redirects, tee, cp, mv, rm, ...), and the command policy: no skipped hooks,
 * no force pushes or decrypted secrets, and the user's say-so for commits, pushes,
 * GitHub changes, infrastructure and destructive scripts (shell.ts). Fails closed.
 */
import { spawnSync } from "node:child_process";
import { isAbsolute, join, relative } from "node:path";
import { verdictFor } from "./file-rules";
import { defaultBranch, ROOT, readInput, respond } from "./lib";
import { commandPolicy, writeTargets } from "./shell";

const input = await readInput({ failClosed: true });
const command = typeof input.tool_input?.command === "string" ? input.tool_input.command : "";
if (!command) process.exit(0);

const decide = (decision: "deny" | "ask", reason: string) =>
  respond({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  });

const policy = commandPolicy(command);
if (policy?.decision === "deny") decide("deny", policy.reason);

const branch = await defaultBranch();
const cwd = input.cwd || ROOT;
for (const target of writeTargets(command)) {
  const path = relative(ROOT, isAbsolute(target) ? target : join(cwd, target));
  if (path.startsWith("..")) continue;
  const shipped =
    spawnSync("git", ["cat-file", "-e", `${branch}:${path}`], { cwd: ROOT }).status === 0;
  // A shell write replaces content the hook can't see, so image tags count as touched.
  const verdict = verdictFor({ path, shipped, after: "tag:" });
  if (verdict?.decision === "deny") decide("deny", `${path}: ${verdict.reason}`);
  if (verdict) decide("ask", `${path}: ${verdict.reason}`);
}
if (policy) decide(policy.decision, policy.reason);
