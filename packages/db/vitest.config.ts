import { coverage } from "@repo/vitest-config";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: coverage({ lines: 61, functions: 60, branches: 65, statements: 60 }),
    include: ["test/**/*.test.ts"],
    globalSetup: ["./test/global-setup.ts"],
    testTimeout: 30_000,
    // Cloning the template waits while another package's run prepares it.
    hookTimeout: 60_000,
  },
});
