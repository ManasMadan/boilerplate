/**
 * PostToolUse (Edit|Write|MultiEdit): format the one file just edited, so diffs stay
 * clean without a full lint run. Type-checking is left to the Stop hook: running tsc
 * on every edit flaps mid-refactor and costs seconds each time.
 */
import { $ } from "bun";
import { ROOT, readInput, targetPath } from "./lib";

const input = await readInput();
const file = targetPath(input);
if (!file) process.exit(0);

if (/\.(ts|tsx|js|mjs|cjs|json|jsonc|css)$/.test(file)) {
  await $`bunx biome check --write --no-errors-on-unmatched --files-ignore-unknown=true ${file}`
    .cwd(ROOT)
    .quiet()
    .nothrow();
} else if (file.endsWith(".py")) {
  await $`uv run --project apps/ai ruff format ${file}`.cwd(ROOT).quiet().nothrow();
}
