/**
 * Coverage every vitest package shares. Each run reports, as LCOV, every source file its
 * tests load, in any workspace package (`allowExternal`), so a shared package gets credit
 * from the apps that really exercise it. There are no per-package thresholds: the rule is
 * 100% of every file across all suites together, which `bun scripts/coverage.ts` checks
 * on the merged reports (after `bun run test:coverage`), and which a package's own tests
 * alone couldn't judge.
 */
import type { CoverageOptions } from "vitest/node";

export function coverage(): CoverageOptions {
  return {
    provider: "v8",
    // No `include`: only the files the tests load are reported, wherever they are. A file
    // no test loads is caught by scripts/coverage.ts, from the list of tracked files.
    allowExternal: true,
    exclude: [
      "**/node_modules/**",
      "**/*.test.{ts,tsx}",
      "**/*.spec.{ts,tsx}",
      "**/*.d.ts",
      "**/test/**",
      "**/e2e/**",
      // Generated code, configs, and entry points that only start a process.
      "**/generated/**",
      "**/*.gen.ts",
      "**/*.config.{ts,mts}",
      "**/src/main.ts",
    ],
    reporter: ["text-summary", "lcov"],
    // Written even when a test fails, so the merge still shows what the rest covered.
    reportOnFailure: true,
  };
}
