/**
 * Two projects: `unit` (src/, no services needed; runs in CI's unit job) and
 * `integration` (test/, against real Postgres and Redis from docker compose).
 */
import { defineConfig } from "vitest/config";

const env = { NODE_ENV: "test", LOG_LEVEL: "silent" };

export default defineConfig({
  test: {
    projects: [
      { test: { name: "unit", include: ["src/**/*.test.ts"], env } },
      {
        test: {
          name: "integration",
          include: ["test/**/*.test.ts"],
          // Each file gets its own database cloned from the migrated template.
          globalSetup: ["./test/global-setup.ts"],
          testTimeout: 30_000,
          env,
        },
      },
    ],
  },
});
