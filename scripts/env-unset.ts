/**
 * Removes one variable from .env without printing the file.
 *
 *   bun run env:unset OLD_VARIABLE
 */
import { ENV_PATH, ok, removeEnvValue, warn } from "./lib";

/** Removes KEY (`argv`'s first word) from the file at `path`; the exit code. */
export function envUnset(argv = process.argv.slice(2), path = ENV_PATH): number {
  const [key] = argv;
  if (!key || !/^[A-Z][A-Z0-9_]*$/.test(key)) {
    console.error("Usage: bun run env:unset KEY   (UPPER_SNAKE_CASE)");
    return 1;
  }
  if (removeEnvValue(path, key)) ok(`${key} removed from .env`);
  else warn(`${key} isn't in .env`);
  return 0;
}

if (import.meta.main) process.exit(envUnset());
