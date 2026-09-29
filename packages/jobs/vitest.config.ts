/**
 * Two projects: `unit` (src/, no services needed) and `integration` (test/, against
 * the docker compose Valkey).
 */
import { coverage } from "@repo/vitest-config";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: coverage({ lines: 74, functions: 41, branches: 44, statements: 73 }),
    projects: [
      { test: { name: "unit", include: ["src/**/*.test.ts"] } },
      { test: { name: "integration", include: ["test/**/*.test.ts"], testTimeout: 20_000 } },
    ],
  },
});
