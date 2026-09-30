/**
 * Shared helpers for Claude Code hooks. Hooks receive a JSON event on stdin and answer
 * with JSON on stdout (https://code.claude.com/docs/en/hooks). Keep them fast: they run
 * on every matching tool call.
 */
import { mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import { $ } from "bun";

export const ROOT = process.env.CLAUDE_PROJECT_DIR ?? join(import.meta.dirname, "../..");
export const STATE_DIR = join(ROOT, ".claude/.state");
mkdirSync(STATE_DIR, { recursive: true });

export interface HookInput {
  session_id: string;
  hook_event_name: string;
  cwd: string;
  tool_name?: string;
  tool_input?: {
    file_path?: string;
    notebook_path?: string;
    command?: string;
    [key: string]: unknown;
  };
  stop_hook_active?: boolean;
  source?: string;
}

export async function readInput(): Promise<HookInput> {
  return JSON.parse(await Bun.stdin.text()) as HookInput;
}

export function respond(output: Record<string, unknown>): never {
  process.stdout.write(JSON.stringify(output));
  process.exit(0);
}

/**
 * A fingerprint of the working tree's content: the diff against HEAD and the content of
 * every untracked file. Names and line counts aren't enough: rewriting an untracked file,
 * or changing a line that was already changed, keeps both the same.
 */
export async function treeFingerprint(cwd = ROOT): Promise<string> {
  const diff = await $`git diff HEAD --binary`.cwd(cwd).quiet().nothrow().text();
  const untracked = (
    await $`git ls-files -o --exclude-standard -z`.cwd(cwd).quiet().nothrow().text()
  )
    .split("\0")
    .filter(Boolean);
  const hashes = untracked.length
    ? await $`git hash-object -- ${untracked}`.cwd(cwd).quiet().nothrow().text()
    : "";
  const lines = untracked.map((file, index) => `${file} ${hashes.split("\n")[index] ?? ""}`);
  return new Bun.CryptoHasher("sha256").update(diff).update(lines.join("\n")).digest("hex");
}

/** Where the turn's starting fingerprint and its Stop re-check count are kept. */
export const turnFile = (session: string) => join(STATE_DIR, `turn-${session}.txt`);
export const stopCountFile = (session: string) => join(STATE_DIR, `stop-${session}.count`);
/** The tree the Stop hook last asked for the full checks on (so it asks once per state). */
export const askedFile = (session: string) => join(STATE_DIR, `asked-${session}.txt`);

/** Files changed against HEAD, untracked ones included, that still exist. */
export async function changedFiles(cwd = ROOT): Promise<string[]> {
  const tracked = await $`git diff HEAD --name-only --diff-filter=d -z`
    .cwd(cwd)
    .quiet()
    .nothrow()
    .text();
  const untracked = await $`git ls-files -o --exclude-standard -z`
    .cwd(cwd)
    .quiet()
    .nothrow()
    .text();
  return [...new Set(`${tracked}${untracked}`.split("\0").filter(Boolean))].sort();
}

/** The repository's default branch (origin's HEAD), for "does it fail there too". */
export async function defaultBranch(cwd = ROOT): Promise<string> {
  const ref = await $`git symbolic-ref --quiet --short refs/remotes/origin/HEAD`
    .cwd(cwd)
    .quiet()
    .nothrow()
    .text();
  return ref.trim().replace(/^origin\//, "") || "master";
}

/** Repo-relative path of the file a tool call targets, or null. */
export function targetPath(input: HookInput): string | null {
  const file = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
  return typeof file === "string" ? relative(ROOT, file) : null;
}
