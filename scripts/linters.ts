/**
 * The linters that don't come from npm, each at a pinned version: `bun scripts/linters.ts
 * <name>` (or `bun run lint:<name>`) runs one over every file git tracks or would that it
 * reads. `bun run lint` runs them all, so CI's lint job does, and the pre-commit hook runs
 * those that read a staged file.
 *
 *   actionlint   the workflows, and shellcheck on their `run:` blocks
 *   zizmor       the workflows' and actions' security (.github/zizmor.yml), offline
 *
 * Each uses a local binary of its version, else its image in Docker; with neither, it
 * fails and says how to get one, rather than skipping the check.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fail, ok, ROOT, type Run, runMain, runSync } from "./lib";

type Linter = {
  /** Its image, without the tag. */
  image: string;
  /** The image's tag: the version CI runs. */
  version: string;
  /** Where its releases are, to install that version. */
  releases: string;
  /** Whether it checks `path` (from the repository root). */
  reads: (path: string) => boolean;
  /** Its arguments, given the files it checks. */
  args: (files: string[]) => string[];
};

export const LINTERS = {
  actionlint: {
    image: "rhysd/actionlint",
    // renovate: datasource=docker depName=rhysd/actionlint
    version: "1.7.12",
    releases: "https://github.com/rhysd/actionlint/releases",
    reads: (path) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path),
    args: (files) => files,
  },
  zizmor: {
    image: "ghcr.io/zizmorcore/zizmor",
    // renovate: datasource=docker depName=ghcr.io/zizmorcore/zizmor
    version: "1.30.1",
    releases: "https://github.com/zizmorcore/zizmor/releases",
    reads: (path) => /^\.github\/.+\.ya?ml$/.test(path),
    // Offline: the same audits with or without a GitHub token in the environment.
    args: () => ["--offline", "--config=.github/zizmor.yml", ".github"],
  },
} satisfies Record<string, Linter>;

/** Every file under `root` git tracks or would (new ones too), that still exists. */
export function repositoryFiles(run: Run = runSync, root = ROOT): string[] {
  return run("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: root,
  })
    .stdout.split("\0")
    .filter((path) => path && existsSync(join(root, path)));
}

/** The command that runs `name` at its version: a local binary of it, else Docker. */
function command(name: string, linter: Linter, run: Run, root: string): string[] | undefined {
  const local = run(name, ["--version"], { cwd: root });
  if (`${local.stdout}${local.stderr}`.split(/\s+/).includes(linter.version.replace(/^v/, ""))) {
    return [name];
  }
  if (run("docker", ["info"], { cwd: root, stdio: "ignore" }).status === 0) {
    return [
      "docker",
      ...["run", "--rm", "--memory=512m", "-v", `${root}:${root}:ro`, "-w", root],
      ...["--entrypoint", name, `${linter.image}:${linter.version}`],
    ];
  }
  return undefined;
}

/** Runs the linter `argv[0]` over the files at `root` it reads; the exit code. */
export function lint(argv = process.argv.slice(2), run = runSync, root = ROOT): number {
  const [name = ""] = argv;
  const linter: Linter | undefined = Object.entries(LINTERS).find(([key]) => key === name)?.[1];
  if (!linter) {
    fail(`Which linter? One of ${Object.keys(LINTERS).join(", ")}.`);
    return 1;
  }
  const files = repositoryFiles(run, root).filter(linter.reads);
  if (files.length === 0) {
    ok(`${name}: nothing to check`);
    return 0;
  }
  const [program = "", ...rest] = command(name, linter, run, root) ?? [];
  if (!program) {
    fail(
      `${name} ${linter.version} isn't installed and Docker isn't running: install that version (${linter.releases}) or start Docker`,
    );
    return 1;
  }
  return (
    run(program, [...rest, ...linter.args(files)], { cwd: root, stdio: "inherit" }).status ?? 1
  );
}

await runMain(import.meta, lint);
