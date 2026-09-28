/**
 * PreToolUse (Edit|Write|MultiEdit|NotebookEdit): refuse edits that would be lost or
 * dangerous, and say what to do instead. Runs in well under 100ms.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT, readInput, respond, targetPath } from "./lib";

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
    // Applied migrations are history: editing one desynchronises every database that ran it.
    test: (path) =>
      /prisma\/migrations\/[^/]+\/migration\.sql$/.test(path) && existsSync(join(ROOT, path)),
    reason:
      "Existing migrations are immutable. Create a new one with `bun run db:migrate` (see the db-change skill).",
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
