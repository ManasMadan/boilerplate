/**
 * Shared helpers for Claude Code hooks. Hooks receive a JSON event on stdin and answer
 * with JSON on stdout (https://code.claude.com/docs/en/hooks). Keep them fast: they run
 * on every matching tool call.
 */
import { mkdirSync } from "node:fs";
import { join, relative } from "node:path";

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

/** Repo-relative path of the file a tool call targets, or null. */
export function targetPath(input: HookInput): string | null {
  const file = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
  return typeof file === "string" ? relative(ROOT, file) : null;
}
