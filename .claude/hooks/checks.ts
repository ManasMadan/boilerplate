/**
 * Which fast checks a set of changed files needs (the Stop hook runs them, verify-turn.ts).
 * Pure, so it's tested without git or a turn (checks.test.ts).
 */

export interface Check {
  label: string;
  command: string[];
}

/** Files turbo's `--affected` can't see: nothing in a workspace package owns them. */
const outsidePackages = (file: string) => !/^(apps|packages)\//.test(file);
const LINTED = /\.(ts|tsx|js|mjs|cjs|json|jsonc|css)$/;

/** The checks for `changed` (repo-relative paths that still exist), cheapest first. */
export function checksFor(changed: string[]): Check[] {
  const checks: Check[] = [];
  const linted = changed.filter((file) => LINTED.test(file));
  if (linted.length) {
    checks.push({
      label: "Biome on the changed files",
      command: [
        "bunx",
        "biome",
        "check",
        "--no-errors-on-unmatched",
        "--files-ignore-unknown=true",
        ...linted,
      ],
    });
  }
  if (changed.some((file) => !outsidePackages(file))) {
    checks.push({
      label: "lint, types and unit tests of the affected packages",
      command: [
        "bunx",
        "turbo",
        "run",
        "lint",
        "check-types",
        "test",
        "--affected",
        "--output-logs=errors-only",
      ],
    });
  }
  const scripts = changed.some((file) => /^scripts\/.*\.ts$/.test(file));
  const hooks = changed.some((file) => /^\.claude\/hooks\/.*\.ts$/.test(file));
  if (scripts)
    checks.push({ label: "types of scripts/", command: ["bunx", "tsc", "-p", "scripts"] });
  if (hooks) {
    checks.push({ label: "types of the hooks", command: ["bunx", "tsc", "-p", ".claude/hooks"] });
  }
  if (scripts || hooks) {
    checks.push({
      label: "tests of scripts/ and the hooks",
      command: [
        "bun",
        "test",
        // Paths, not names: `bun test` treats a bare word as a filter and skips dot folders.
        ...(scripts ? ["./scripts/"] : []),
        ...(hooks ? ["./.claude/hooks/"] : []),
      ],
    });
  }
  // Unused files, exports and dependencies: whenever code or a manifest changed.
  if (changed.some((file) => /\.(ts|tsx)$/.test(file) || file.endsWith("package.json"))) {
    checks.push({ label: "knip", command: ["bunx", "knip", "--no-progress"] });
  }
  return checks;
}

/** Whether the change is too wide for the Stop hook's budget (every package depends on it). */
export function touchesEverything(changed: string[]): boolean {
  return changed.some((file) =>
    ["package.json", "bun.lock", "turbo.json", "biome.jsonc", "tsconfig.json"].includes(file),
  );
}
