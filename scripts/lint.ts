/**
 * Every lint step, `bun run lint`: formatting and lint (Biome), architecture boundaries,
 * unused code (knip), shortcut markers, and each package's own lint (turbo). All of
 * them run even when one fails, so one failure never hides another's results; it exits
 * non-zero at the end if any failed. CI's lint job runs the same command.
 */
import { spawnSync } from "node:child_process";
import { fail, ok, ROOT } from "./lib";

/** The steps, in order, each a `bun run` script or a command. */
export const STEPS: string[][] = [
  ["bunx", "biome", "check", "."],
  ["bun", "run", "lint:boundaries"],
  ["bun", "run", "lint:unused"],
  ["bun", "run", "lint:markers"],
  ["bun", "run", "lint:suppressions"],
  ["bunx", "turbo", "run", "lint"],
];

/** Runs every step (the runner returns its exit code) and returns the ones that failed. */
export function runAll(steps: string[][], run: (step: string[]) => number): string[][] {
  return steps.filter((step) => run(step) !== 0);
}

if (import.meta.main) {
  const failed = runAll(STEPS, (step) => {
    const [command = "", ...args] = step;
    return spawnSync(command, args, { cwd: ROOT, stdio: "inherit" }).status ?? 1;
  });
  for (const step of STEPS) {
    if (failed.includes(step)) fail(step.join(" "));
    else ok(step.join(" "));
  }
  process.exit(failed.length ? 1 : 0);
}
