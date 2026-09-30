/**
 * One-time (and re-runnable) project setup: creates .env with fresh secrets, installs
 * dependencies, starts local services, applies migrations and generates code.
 *
 *   bun run setup
 *
 * Safe to run again: existing .env values are kept; only missing variables are added
 * and placeholders are replaced.
 */

import { copyFileSync, existsSync } from "node:fs";
// By path, not package name: setup writes .env before `bun install` has linked packages.
import { fillPlaceholders } from "../packages/testing/src/secrets";
import { ENV_EXAMPLE_PATH, ENV_PATH, ok, readEnv, runSync, writeEnvValue } from "./lib";

/** The steps after .env, each a command that must pass before the next. */
const STEPS: [string, string[]][] = [
  ["2. Dependencies", ["bun", "install"]],
  ["3. Local services", ["bun", "scripts/services.ts", "up"]],
  ["4. Database", ["bun", "run", "db:deploy"]],
  ["5. Code generation", ["bun", "run", "gen"]],
];

/** Writes `envPath` from `examplePath`, then runs the steps; the exit code. */
export function setup({ run = runSync, envPath = ENV_PATH, examplePath = ENV_EXAMPLE_PATH } = {}) {
  console.log("\n1. Environment");
  if (!existsSync(envPath)) {
    copyFileSync(examplePath, envPath);
    ok("Created .env from .env.example");
  }
  const env = readEnv(envPath);
  for (const [key, value] of readEnv(examplePath)) {
    if (!env.has(key)) writeEnvValue(envPath, key, value);
  }
  // Placeholders become fresh secrets in each variable's format (the VAPID pair together).
  const current = Object.fromEntries(readEnv(envPath));
  for (const [key, value] of Object.entries(fillPlaceholders(current))) {
    if (value !== current[key]) {
      writeEnvValue(envPath, key, value);
      ok(`Generated ${key}`);
    }
  }

  for (const [title, [command = "", ...args]] of STEPS) {
    console.log(`\n${title}`);
    const { status } = run(command, args, { stdio: "inherit" });
    if (status !== 0) return status ?? 1;
  }
  console.log("\nSetup complete. Start everything with `bun dev`.\n");
  return 0;
}

if (import.meta.main) process.exit(setup());
