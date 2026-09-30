/**
 * Two projects: `unit` (src/, no services needed; runs in CI's unit job) and
 * `integration` (test/, against real Postgres and Redis from docker compose).
 */
import { applyTestEnvironment } from "@repo/testing/environment";
import { coverage, decoratorMetadata } from "@repo/vitest-config";
import { defineConfig } from "vitest/config";

// .env.example's values (not the developer's .env), before global setup and the workers.
applyTestEnvironment();

const env = { NODE_ENV: "test", LOG_LEVEL: "silent" };

export default defineConfig({
  plugins: [decoratorMetadata()],
  test: {
    coverage: coverage(),
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
