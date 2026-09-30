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
import { $ } from "bun";
// By path, not package name: setup writes .env before `bun install` has linked packages.
import { fillPlaceholders } from "../packages/testing/src/secrets";
import { ENV_EXAMPLE_PATH, ENV_PATH, ok, readEnv, writeEnvValue } from "./lib";

console.log("\n1. Environment");
if (!existsSync(ENV_PATH)) {
  copyFileSync(ENV_EXAMPLE_PATH, ENV_PATH);
  ok("Created .env from .env.example");
}
const env = readEnv(ENV_PATH);
for (const [key, value] of readEnv(ENV_EXAMPLE_PATH)) {
  if (!env.has(key)) writeEnvValue(ENV_PATH, key, value);
}
// Placeholders become fresh secrets in each variable's format (the VAPID pair together).
const current = Object.fromEntries(readEnv(ENV_PATH));
for (const [key, value] of Object.entries(fillPlaceholders(current))) {
  if (value !== current[key]) {
    writeEnvValue(ENV_PATH, key, value);
    ok(`Generated ${key}`);
  }
}

console.log("\n2. Dependencies");
await $`bun install`;

console.log("\n3. Local services");
await $`bun scripts/services.ts up`;

console.log("\n4. Database");
await $`bun run db:deploy`;

console.log("\n5. Code generation");
await $`bun run gen`;

console.log("\nSetup complete. Start everything with `bun dev`.\n");
