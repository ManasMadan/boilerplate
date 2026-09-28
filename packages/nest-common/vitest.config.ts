/**
 * Two projects: `unit` (src/, no services needed) and `integration` (test/, against
 * the docker compose Redis and RustFS).
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      { test: { name: "unit", include: ["src/**/*.test.ts"] } },
      { test: { name: "integration", include: ["test/**/*.test.ts"], testTimeout: 20_000 } },
    ],
  },
});
