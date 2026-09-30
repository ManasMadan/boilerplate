/**
 * Removes one variable from .env without printing the file.
 *
 *   bun run env:unset OLD_VARIABLE
 */
import { ENV_PATH, ok, removeEnvValue, warn } from "./lib";

const [key] = process.argv.slice(2);
if (!key || !/^[A-Z][A-Z0-9_]*$/.test(key)) {
  console.error("Usage: bun run env:unset KEY   (UPPER_SNAKE_CASE)");
  process.exit(1);
}
if (removeEnvValue(ENV_PATH, key)) ok(`${key} removed from .env`);
else warn(`${key} isn't in .env`);
