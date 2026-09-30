/**
 * PostToolUse (Edit|Write|MultiEdit): format the one file just edited and apply the safe
 * lint fixes, then tell Claude about any lint error that's left, so a problem is seen at
 * the edit rather than at the end of the turn. Type-checking is left to the Stop hook:
 * running tsc on every edit flaps mid-refactor and costs seconds each time.
 */
import { $ } from "bun";
import { ROOT, readInput, respond, targetPath } from "./lib";

$.cwd(ROOT);

const input = await readInput();
const file = targetPath(input);
if (!file) process.exit(0);

/**
 * Runs the fixers quietly, then the check whose output (if it fails) Claude should see.
 * Commands run from the repository root unless they set their own directory.
 */
async function fixThenCheck(fix: ReturnType<typeof $>[], check?: ReturnType<typeof $>) {
  for (const command of fix) await command.quiet().nothrow();
  if (!check) return "";
  const result = await check.quiet().nothrow();
  return result.exitCode === 0 ? "" : `${result.stdout}${result.stderr}`.trim();
}

let remaining = "";
if (/\.(ts|tsx|js|mjs|cjs|json|jsonc|css)$/.test(file)) {
  const flags = ["--no-errors-on-unmatched", "--files-ignore-unknown=true"];
  remaining = await fixThenCheck(
    [$`bunx biome check --write ${flags} ${file}`],
    $`bunx biome check ${flags} --colors=off ${file}`,
  );
} else if (file.endsWith(".py")) {
  remaining = await fixThenCheck(
    [
      $`uv run --project apps/ai ruff check --fix --quiet ${file}`,
      $`uv run --project apps/ai ruff format --quiet ${file}`,
    ],
    $`uv run --project apps/ai ruff check --output-format=concise ${file}`,
  );
} else if (file.endsWith(".prisma")) {
  // The schema is a folder, formatted as a whole, from its package (prisma.config.ts).
  await fixThenCheck([$`bunx prisma format`.cwd(`${ROOT}/packages/db`)]);
} else if (/\.(tf|tfvars|hcl)$/.test(file) && !file.endsWith(".lock.hcl")) {
  await fixThenCheck([$`tofu fmt ${file}`]);
}

if (remaining) {
  respond({
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: `Lint errors left in ${file} after the automatic fixes; fix them now:\n${remaining.split("\n").slice(-30).join("\n")}`,
    },
  });
}
