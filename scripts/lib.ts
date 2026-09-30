/** Small helpers shared by the repo scripts (setup, doctor, env:set). */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const ROOT = join(import.meta.dirname, "..");
export const ENV_PATH = join(ROOT, ".env");
export const ENV_EXAMPLE_PATH = join(ROOT, ".env.example");

/** Values in .env.example that must never reach a real environment. */
// By path: scripts run before `bun install` (setup) and this module uses only Node built-ins.
export { PLACEHOLDER } from "../packages/testing/src/secrets";

export function parseEnv(text: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (match?.[1] !== undefined) entries.set(match[1], match[2] ?? "");
  }
  return entries;
}

export const readEnv = (path: string) =>
  existsSync(path) ? parseEnv(readFileSync(path, "utf8")) : new Map<string, string>();

/** Sets or appends one KEY=value line, preserving every other line and comment. */
export function writeEnvValue(path: string, key: string, value: string) {
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^\\s*${key}\\s*=.*$`, "m");
  const next = pattern.test(text)
    ? text.replace(pattern, line)
    : `${text.replace(/\n?$/, "\n")}${line}\n`;
  writeFileSync(path, next);
}

export const ok = (message: string) => console.log(`  \x1b[32m✔\x1b[0m ${message}`);
export const warn = (message: string) => console.log(`  \x1b[33m!\x1b[0m ${message}`);
export const fail = (message: string) => console.log(`  \x1b[31m✖\x1b[0m ${message}`);
