/**
 * Coverage for a package's own source, with thresholds that fail the run when coverage
 * drops (`bun run test:coverage`, and CI). Each package passes the floor it currently
 * meets, rounded down and less a point for paths that only run sometimes (retries,
 * timing): raise it as tests are added; lowering it needs a reason in review. Shared
 * packages score low on their own tests where the services' and apps' suites exercise
 * them (contracts, client hooks, the fake Stripe).
 * The numbers count unit and integration tests together, since most behaviour here is
 * proved against real services.
 */
import type { CoverageOptions } from "vitest/node";

export interface Thresholds {
  lines: number;
  functions: number;
  branches: number;
  statements: number;
}

export function coverage(thresholds: Thresholds): CoverageOptions {
  return {
    provider: "v8",
    include: ["src/**/*.{ts,tsx}"],
    exclude: [
      "src/**/*.test.{ts,tsx}",
      "src/**/*.d.ts",
      // Generated code, and entry points that only start a process.
      "src/generated/**",
      "src/**/*.gen.ts",
      "src/main.ts",
    ],
    reporter: ["text-summary", "lcov"],
    thresholds,
  };
}
