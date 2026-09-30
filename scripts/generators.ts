/**
 * Keeps the code generators honest (turbo/generators): runs each one, then everything a
 * pull request must pass on what they wrote: lint (Biome, dependency rules, knip), types,
 * the unit tests, and the generated feature's own integration tests.
 *
 *   bun scripts/generators.ts              in a scratch worktree of this checkout
 *   bun scripts/generators.ts --in-place   here (CI, whose checkout is thrown away)
 *
 * The integration tests need the local services (`bun run db:up`) and a migrated database.
 */
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { $ } from "bun";
import { fail, ok, ROOT } from "./lib";

/** An api feature over the todo table, and a package: names nothing else uses. */
const FEATURE = ["smoke-notes", "smoke-note", "todo", '{"title":"Smoke"}'];
const PACKAGE = ["smoke-kit", "A package the generators check makes."];

/** A copy of this checkout, uncommitted and untracked files included, with its own install. */
async function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "generators-"));
  await $`git worktree add --detach --quiet ${dir} HEAD`.cwd(ROOT);
  const files = (await $`git ls-files -co --exclude-standard -z`.cwd(ROOT).text())
    .split("\0")
    .filter(Boolean);
  for (const file of files) {
    try {
      cpSync(join(ROOT, file), join(dir, file), { force: true });
    } catch {
      // Deleted in the working tree but still in the index: nothing to copy.
    }
  }
  ok(`scratch copy in ${dir}`);
  await $`bun install --frozen-lockfile`.cwd(dir).quiet();
  return {
    dir,
    remove: async () => {
      await $`git worktree remove --force ${dir}`.cwd(ROOT).nothrow();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

type Command = () => ReturnType<typeof $>;

/** Runs one check; the command is built only now, so nothing starts before its turn. */
async function step(label: string, cwd: string, command: Command) {
  const result = await command().cwd(cwd).nothrow().quiet();
  const output = `${result.stdout}${result.stderr}`;
  // turbo gen exits 0 when one of the generator's actions fails; its output says so. And
  // vitest exits 0 when a name filter matches nothing, so a test step must pass something.
  const failedGenerator = /Failed to run|>>> Error/.test(output);
  const ranNothing =
    label.includes("tests") && !/Tests\s+\d+ passed/.test(stripVTControlCharacters(output));
  if (result.exitCode !== 0 || failedGenerator || ranNothing) {
    fail(label);
    console.error(output.trim().split("\n").slice(-60).join("\n"));
    return false;
  }
  ok(label);
  return true;
}

async function check(dir: string) {
  const api = join(dir, "apps/api");
  const steps: [string, string, Command][] = [
    ["generate an api feature", dir, () => $`bunx turbo gen api-feature --args ${FEATURE}`],
    ["generate a package", dir, () => $`bunx turbo gen package --args ${PACKAGE}`],
    ["lint", dir, () => $`bun run lint`],
    ["types", dir, () => $`bun run check-types`],
    ["unit tests", dir, () => $`bun run test`],
    [
      "the feature's integration tests",
      api,
      () => $`bunx vitest run --project integration test/api.integration.test.ts -t ${FEATURE[0]}`,
    ],
  ];
  for (const [label, cwd, command] of steps) {
    if (!(await step(label, cwd, command))) return false;
  }
  return true;
}

if (import.meta.main) {
  const inPlace = process.argv.includes("--in-place");
  const copy = inPlace ? undefined : await scratch();
  const passed = await check(copy?.dir ?? ROOT).finally(() => copy?.remove());
  if (!passed) process.exit(1);
  ok("both generators write code that passes lint, types and its tests");
}
