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
      // Generated code and configs.
      "**/generated/**",
      "**/*.gen.ts",
      "**/*.config.{ts,mts}",
    ],
    reporter: ["text-summary", "lcov"],
    // Written even when a test fails, so the merge still shows what the rest covered.
    reportOnFailure: true,
  };
}

/**
 * For NestJS packages (`plugins: [decoratorMetadata()]`). oxc compiles the type of each
 * injected constructor parameter to `typeof X === "undefined" ? Object : X`, a guard for
 * a class still undefined in an import cycle. That branch is in no source line and no
 * test can take it, so coverage would count it against every service; vitest already
 * leaves out SWC's decorator code the same way. It's compiled to plain `X` here (padded
 * to the same length, so the source map still holds). An import cycle then fails Nest's
 * injection with Nest's own error, as it would anyway with `Object`.
 */
export function decoratorMetadata() {
  const guard = /typeof ([\w$]+) === "undefined" \? Object : \1\b/g;
  return {
    name: "repo:decorator-metadata",
    enforce: "post" as const,
    transform(code: string) {
      if (!code.includes('=== "undefined" ? Object : ')) return undefined;
      const replaced = code.replace(guard, (match, name: string) => name.padEnd(match.length));
      return { code: replaced, map: null };
    },
  };
}
