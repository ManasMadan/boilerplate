/**
 * The pre-commit hook's checks of the staged files, side by side: lint-staged (Biome,
 * ruff, prisma format, Squawk on new migrations, tofu fmt, the SOPS check), the secret
 * scan, and, when a staged file is one they read, the infrastructure misconfiguration
 * scan (Trivy) and the known-vulnerability scan (OSV). lint-staged is the only one that
 * writes (it fixes and restages files); the others only read, so they run beside it.
 * As many at once as the machine has cores, less one. A step's output is printed only
 * when it fails; after a failure no new step starts, but the running ones finish (a
 * lint-staged stopped halfway could leave its backup of unstaged changes behind).
 */
import { spawn } from "node:child_process";
import { availableParallelism } from "node:os";
import { fail, ok, ROOT, runMain, runSync } from "./lib";
import { misconfigReads } from "./misconfig";
import { osvReads } from "./osv";

type Step = { name: string; command: string[]; when: (staged: string[]) => boolean };

export const STEPS: Step[] = [
  { name: "lint-staged", command: ["bunx", "lint-staged"], when: () => true },
  { name: "Secrets (gitleaks)", command: ["bun", "scripts/secret-scan.ts"], when: () => true },
  {
    name: "Infrastructure misconfigurations (Trivy)",
    command: ["bun", "scripts/misconfig.ts"],
    when: (staged) => staged.some(misconfigReads),
  },
  {
    name: "Known vulnerabilities (OSV)",
    command: ["bun", "scripts/osv.ts"],
    when: (staged) => staged.some(osvReads),
  },
];

type Finished = { status: number | null; output: string };

/** Runs a command at the repository root to the end, its stdout and stderr as one text. */
export function start([command = "", ...args]: string[]): Promise<Finished> {
  return new Promise((resolve) => {
    // No optional git locks (an index refresh while reading): lint-staged must be able to
    // take the index lock to restage what it fixed while the others read.
    const child = spawn(command, args, {
      cwd: ROOT,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", (error) => resolve({ status: null, output: `${error.message}\n` }));
    child.on("close", (status) => resolve({ status, output }));
  });
}

/** The staged paths, from the repository root. */
export const stagedFiles = (run = runSync) =>
  run("git", ["diff", "--cached", "--name-only", "-z"], { cwd: ROOT })
    .stdout.split("\0")
    .filter(Boolean);

/** Runs the steps the staged files need; the exit code. */
export async function preCommit({
  staged = stagedFiles(),
  run = start,
  slots = Math.max(1, availableParallelism() - 1),
} = {}): Promise<number> {
  const queue = STEPS.filter((step) => step.when(staged));
  let failed = false;
  const worker = async () => {
    for (let step = queue.shift(); step && !failed; step = queue.shift()) {
      const began = performance.now();
      const { status, output } = await run(step.command);
      const took = `${((performance.now() - began) / 1000).toFixed(1)}s`;
      if (status === 0) {
        ok(`${step.name} (${took})`);
      } else {
        failed = true;
        process.stdout.write(output);
        fail(`${step.name} failed (${took})`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(slots, queue.length) }, worker));
  return failed ? 1 : 0;
}

await runMain(import.meta, preCommit);
