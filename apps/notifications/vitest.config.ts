import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    // Integration tests get their own database cloned from the migrated template.
    globalSetup: ["./test/global-setup.ts"],
    testTimeout: 30_000,
    env: { NODE_ENV: "test", LOG_LEVEL: "silent" },
  },
});
