/**
 * Sets one variable in .env without printing the file.
 *
 *   bun run env:set STRIPE_SECRET_KEY=sk_test_...
 *   echo "sk_test_..." | bun run env:set STRIPE_SECRET_KEY   # value from stdin, not argv
 *
 * Claude is not allowed to read .env (it holds secrets), so this is how a prompt like
 * "use my Stripe test key" gets applied.
 */
import { ENV_PATH, ok, writeEnvValue } from "./lib";

const [arg] = process.argv.slice(2);
if (!arg) {
  console.error(
    "Usage: bun run env:set KEY=value   (or pipe the value on stdin: bun run env:set KEY)",
  );
  process.exit(1);
}

const [key, ...rest] = arg.split("=");
if (!key || !/^[A-Z][A-Z0-9_]*$/.test(key)) {
  console.error(`Invalid variable name "${key}". Use UPPER_SNAKE_CASE.`);
  process.exit(1);
}

const value = rest.length > 0 ? rest.join("=") : (await Bun.stdin.text()).trim();
try {
  writeEnvValue(ENV_PATH, key, value);
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
ok(`${key} updated in .env`);
