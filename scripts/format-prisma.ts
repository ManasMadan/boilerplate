/**
 * Formats the Prisma schema (the pre-commit hook, for staged .prisma files): Prisma
 * formats the schema folder as a whole, from its package, whatever files it's given.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { ROOT } from "./lib";

const format = spawnSync("bunx", ["prisma", "format"], {
  cwd: join(ROOT, "packages/db"),
  stdio: "inherit",
});
process.exit(format.status ?? 1);
