/**
 * One-time (and re-runnable) project setup: creates .env with fresh secrets, installs
 * dependencies, starts local services, applies migrations and generates code.
 *
 *   bun run setup
 *
 * Safe to run again: existing .env values are kept; only missing variables are added
 * and placeholders are replaced.
 */

import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync } from "node:fs";
import { $ } from "bun";
import { ENV_EXAMPLE_PATH, ENV_PATH, ok, PLACEHOLDER, readEnv, writeEnvValue } from "./lib";

console.log("\n1. Environment");
if (!existsSync(ENV_PATH)) {
  copyFileSync(ENV_EXAMPLE_PATH, ENV_PATH);
  ok("Created .env from .env.example");
}
const env = readEnv(ENV_PATH);
for (const [key, value] of readEnv(ENV_EXAMPLE_PATH)) {
  if (!env.has(key)) writeEnvValue(ENV_PATH, key, value);
}
for (const [key, value] of readEnv(ENV_PATH)) {
  if (PLACEHOLDER.test(value)) {
    writeEnvValue(ENV_PATH, key, randomBytes(32).toString("base64url"));
    ok(`Generated a random ${key}`);
  }
}

console.log("\n2. Dependencies");
await $`bun install`;

console.log("\n3. Local services");
await $`docker compose up -d --wait`;

console.log("\n4. Database");
await $`bun run db:deploy`;

console.log("\n5. Code generation");
await $`bun run gen`;

console.log("\nSetup complete. Start everything with `bun dev`.\n");
