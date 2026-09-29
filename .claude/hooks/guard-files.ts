/**
 * PreToolUse (Edit|Write|MultiEdit|NotebookEdit): refuse edits that would be lost or
 * dangerous, and say what to do instead. Runs in well under 100ms.
 */
import { spawnSync } from "node:child_process";
import { ROOT, readInput, respond, targetPath } from "./lib";

/** Whether the file is in master's tree, i.e. it has shipped. */
const onMaster = (path: string) =>
  spawnSync("git", ["cat-file", "-e", `master:${path}`], { cwd: ROOT }).status === 0;

const input = await readInput();
const file = targetPath(input);
if (!file) process.exit(0);

const rules: { test: (path: string) => boolean; reason: string }[] = [
  {
    test: (path) => /(^|\/)\.env(\.|$)/.test(path) && !path.endsWith(".env.example"),
    reason:
      "`.env` holds secrets and is not edited by Claude. Use `bun run env:set KEY=value`, and add new variables to .env.example.",
  },
  {
    test: (path) =>
      /\/generated\//.test(path) || path.endsWith(".gen.ts") || path.endsWith("openapi.json"),
    reason:
      "This file is generated. Change its source (Prisma schema, Pydantic models, contracts) and run `bun run gen`.",
  },
  {
    // Shipped migrations are history: editing one desynchronises every database that ran
    // it. One that isn't on master yet (just written by `bun run db:migrate`) still gets
    // its row-level security and grants added before it's committed.
    test: (path) => /prisma\/migrations\/[^/]+\/migration\.sql$/.test(path) && onMaster(path),
    reason:
      "This migration is on master, so it's immutable. Create a new one with `bun run db:migrate` (see the db-change skill).",
  },
  {
    test: (path) => path === "bun.lock" || path.endsWith("uv.lock"),
    reason:
      "Lockfiles are written by the package manager. Run `bun add`/`bun remove` (or `uv add`) instead.",
  },
];

const hit = rules.find((rule) => rule.test(file));
if (hit) {
  respond({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: hit.reason,
    },
  });
}
