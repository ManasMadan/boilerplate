/**
 * Suppressions, skipped tests and coverage pragmas: each one hides a problem instead of
 * fixing it, so one is refused unless docs/testing.md lists its file with the reason
 * (the "Coverage exceptions", "Skipped tests" and "Suppressions" tables). The Claude Code
 * hook (.claude/hooks/suppressions.ts) applies this to every edit, and
 * `bun scripts/suppressions.ts` (in `bun run lint`, so in CI) to every tracked file.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** What counts, by name; each finds one occurrence per match. */
export const SUPPRESSIONS: Record<string, RegExp> = {
  "@ts-ignore": /@ts-ignore/g,
  "@ts-expect-error": /@ts-expect-error/g,
  "@ts-nocheck": /@ts-nocheck/g,
  "biome-ignore": /biome-ignore/g,
  "eslint-disable": /eslint-disable/g,
  "coverage ignore (v8, c8, istanbul)": /\/\*\s*(v8|c8|istanbul)\s+ignore/g,
  "# pragma: no cover": /#\s*pragma:\s*no cover/g,
  "# type: ignore": /#\s*type:\s*ignore/g,
  "# pyright: ignore": /#\s*pyright:\s*ignore/g,
  "# noqa": /#\s*noqa\b/g,
  "a skipped test (.skip, xit, @pytest.mark.skip)":
    /\b(it|test|describe|suite)\.skip(If)?\s*\(|\bx(it|describe|test)\s*\(|@pytest\.mark\.skip/g,
  "a focused test (.only, fit)": /\b(it|test|describe|suite)\.only\s*\(|\bf(it|describe)\s*\(/g,
};

/** Files that name the patterns as data: this module, its test and the hook's. */
export const DEFINES_THEM = new Set([
  "scripts/suppressions.ts",
  "scripts/suppressions.test.ts",
  ".claude/hooks/suppressions.test.ts",
]);

/** Source files the rules apply to. */
export const CODE = /\.(ts|tsx|js|mjs|cjs|py)$/;

/** How many of each kind `text` has. */
export function countSuppressions(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [name, pattern] of Object.entries(SUPPRESSIONS)) {
    const found = text.match(pattern)?.length ?? 0;
    if (found) counts.set(name, found);
  }
  return counts;
}

/** The kinds `after` has more of than `before`. */
export function addedSuppressions(before: string, after: string): string[] {
  const was = countSuppressions(before);
  return [...countSuppressions(after)]
    .filter(([name, count]) => count > (was.get(name) ?? 0))
    .map(([name]) => name);
}

/** The sections of docs/testing.md whose tables allow a suppression. */
export const EXCEPTION_SECTIONS = ["## Coverage exceptions", "## Skipped tests", "## Suppressions"];

/**
 * The files the exceptions tables in docs/testing.md name (a backticked path in a row
 * under one of EXCEPTION_SECTIONS; other tables in the file allow nothing).
 */
export function listedFiles(root: string): Set<string> {
  const doc = join(root, "docs/testing.md");
  if (!existsSync(doc)) return new Set();
  let inExceptions = false;
  const rows = readFileSync(doc, "utf8")
    .split("\n")
    .filter((line) => {
      if (line.startsWith("## ")) inExceptions = EXCEPTION_SECTIONS.includes(line.trim());
      return inExceptions && line.startsWith("|");
    });
  const paths = rows.flatMap((row) =>
    [...row.matchAll(/`([^`\s]+\.[a-z]+)(:\d+)?`/g)].map((m) => m[1] as string),
  );
  return new Set(paths);
}

/** Tracked source files with a suppression that no exceptions table lists. */
export function unlisted(root: string, files: string[]): { path: string; kinds: string[] }[] {
  const listed = listedFiles(root);
  return files
    .filter((path) => CODE.test(path) && !DEFINES_THEM.has(path) && !/\/generated\//.test(path))
    .filter((path) => !listed.has(path))
    .map((path) => ({
      path,
      kinds: [...countSuppressions(readFileSync(join(root, path), "utf8")).keys()],
    }))
    .filter(({ kinds }) => kinds.length > 0);
}

/** Reports every tracked file under `root` with an unlisted suppression; the exit code. */
export function checkSuppressions(root = join(import.meta.dir, "..")): number {
  const tracked = Bun.spawnSync(["git", "ls-files"], { cwd: root }).stdout.toString().split("\n");
  const found = unlisted(root, tracked);
  for (const { path, kinds } of found)
    console.error(`  \x1b[31m✖\x1b[0m ${path}: ${kinds.join(", ")}`);
  if (found.length === 0) return 0;
  console.error(
    "\nFix the cause, or list the file with the reason in docs/testing.md (Coverage exceptions, Skipped tests or Suppressions).",
  );
  return 1;
}

if (import.meta.main) process.exit(checkSuppressions());
