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
    writeEnvValue(ENV_PATH, key, generateSecret(key));
    ok(`Generated a random ${key}`);
  }
}

/** A fresh secret in the format each variable expects. */
function generateSecret(key: string) {
  const random = randomBytes(32).toString("base64");
  // SecretBox keys carry an id so they can be rotated: "<id>:<32-byte base64 key>".
  if (key === "ENCRYPTION_KEYS") return `${new Date().toISOString().slice(0, 7)}:${random}`;
  return randomBytes(32).toString("base64url");
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
