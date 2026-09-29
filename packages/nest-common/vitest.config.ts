/**
 * Two projects: `unit` (src/, no services needed) and `integration` (test/, against
 * the docker compose Redis and RustFS).
 */
import { coverage } from "@repo/vitest-config";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: coverage({ lines: 54, functions: 46, branches: 52, statements: 53 }),
    projects: [
      { test: { name: "unit", include: ["src/**/*.test.ts"] } },
      { test: { name: "integration", include: ["test/**/*.test.ts"], testTimeout: 20_000 } },
    ],
  },
});
