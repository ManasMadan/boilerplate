/**
 * No `any` in the source: type-coverage, for every TypeScript workspace, at 100%. An
 * `any` turns off checking for everything that flows from it (a JSON body, a job's data,
 * a library's loosely typed result), so each must become `unknown` or a real type.
 * Tests, stories, test setup and generated code are left out; type assertions are
 * allowed (the stricter mode counts them too, and some are the idiomatic way to say
 * what a library can't, like `Object.keys(x) as K[]`).
 *
 *   bun run type-coverage              every workspace
 *   bun run type-coverage apps/api     one, with each `any` it finds
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fail, ok, ROOT, type Run, runSync } from "./lib";

const IGNORED = [
  "**/generated/**",
  "**/*.test.ts",
  "**/*.test.tsx",
  "**/test/**",
  "**/e2e/**",
  "**/*.stories.tsx",
  "**/.storybook/**",
  "**/jest.setup.ts",
];

/** Every workspace with its own tsconfig (the Python service and config packages have none). */
export function workspaces(root = ROOT): string[] {
  return ["apps", "packages"].flatMap((dir) =>
    readdirSync(join(root, dir))
      .map((name) => `${dir}/${name}`)
      .filter((path) => existsSync(join(root, path, "tsconfig.json"))),
  );
}

/** Checks each workspace; the ones below 100%. */
export function check(paths: string[], run: Run = runSync): string[] {
  return paths.filter((path) => {
    const args = ["type-coverage", "-p", `${path}/tsconfig.json`, "--at-least", "100", "--detail"];
    for (const pattern of IGNORED) args.push("--ignore-files", pattern);
    const result = run("bunx", args, { cwd: ROOT });
    if (result.status === 0) {
      ok(path);
      return false;
    }
    fail(path);
    console.error(`${result.stdout}${result.stderr}`.trim());
    return true;
  });
}

/** The command: the given workspaces, or all of them; the exit code. */
export function main(argv = process.argv.slice(2), run: Run = runSync): number {
  return check(argv.length ? argv : workspaces(), run).length ? 1 : 0;
}

if (import.meta.main) process.exit(main());
