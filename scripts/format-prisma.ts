/**
 * Formats the Prisma schema (the pre-commit hook, for staged .prisma files): Prisma
 * formats the schema folder as a whole, from its package, whatever files it's given.
 */
import { join } from "node:path";
import { ROOT, runSync } from "./lib";

/** Formats the schema; Prisma's exit code. */
export function formatPrisma(run = runSync): number {
  return (
    run("bunx", ["prisma", "format"], { cwd: join(ROOT, "packages/db"), stdio: "inherit" })
      .status ?? 1
  );
}

if (import.meta.main) {
  process.exit(formatPrisma());
}
