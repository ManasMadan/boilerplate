import { fileURLToPath } from "node:url";
import { applyTestEnvironment } from "@repo/testing/environment";
import { configDefaults, defineConfig } from "vitest/config";

// .env.example's values (not the developer's .env): next.config.ts validates them.
applyTestEnvironment();

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  // e2e/ is Playwright's (bun run test:e2e).
  test: { exclude: [...configDefaults.exclude, "e2e/**"] },
});
