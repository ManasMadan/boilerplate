import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  // e2e/ is Playwright's (bun run test:e2e).
  test: { exclude: [...configDefaults.exclude, "e2e/**"] },
});
