/**
 * Lints the database migrations a change adds or edits with Squawk (.squawk.toml):
 * `bun run db:lint`. Compares with master (or $GITHUB_BASE_REF in a pull request);
 * migrations already on master are applied everywhere and can't change anyway.
 */
import { spawnSync } from "node:child_process";
import { ok, ROOT } from "./lib";

const SQUAWK = "squawk-cli@2.66.0";
const base = process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : "master";

const diff = spawnSync(
  "git",
  [
    "diff",
    "--name-only",
    "--diff-filter=AM",
    `${base}...HEAD`,
    "--",
    "packages/db/prisma/migrations",
  ],
  { cwd: ROOT, encoding: "utf8" },
);
if (diff.status !== 0) {
  console.error(diff.stderr);
  process.exit(1);
}
const changed = diff.stdout.split("\n").filter((file) => file.endsWith("/migration.sql"));

if (changed.length === 0) {
  ok(`no new migrations since ${base}`);
  process.exit(0);
}
const lint = spawnSync("bunx", [SQUAWK, ...changed], { cwd: ROOT, stdio: "inherit" });
process.exit(lint.status ?? 1);
