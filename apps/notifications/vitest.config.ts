/**
 * Two projects: `unit` (src/, no services needed; runs in CI's unit job) and
 * `integration` (test/, against real Postgres/Redis/Mailpit from docker compose).
 */
import { coverage } from "@repo/vitest-config";
import { defineConfig } from "vitest/config";

const env = { NODE_ENV: "test", LOG_LEVEL: "silent" };

export default defineConfig({
  test: {
    coverage: coverage({ lines: 91, functions: 92, branches: 81, statements: 89 }),
    projects: [
      { test: { name: "unit", include: ["src/**/*.test.ts"], env } },
      {
        test: {
          name: "integration",
          include: ["test/**/*.test.ts"],
          // Each file gets its own database cloned from the migrated template.
          globalSetup: ["./test/global-setup.ts"],
          // Cloning the template waits while another package's run prepares it.
          hookTimeout: 60_000,
          testTimeout: 30_000,
          env,
        },
      },
    ],
  },
});
