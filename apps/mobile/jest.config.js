/**
 * Unit and component tests (React Native Testing Library) on jest-expo's React Native
 * preset. The shared packages ship TypeScript source and are compiled like app code.
 */
module.exports = {
  preset: "jest-expo",
  // e2e/ is Playwright's (bun run test:e2e).
  roots: ["<rootDir>/src"],
  setupFiles: ["./jest.setup.ts"],
  moduleNameMapper: { "^@/(.*)$": "<rootDir>/src/$1", "\\.css$": "<rootDir>/test/style.js" },
  // Several dependencies ship only ES modules as .mjs (oRPC); Babel compiles them too.
  transform: { "\\.mjs$": "babel-jest" },
  moduleFileExtensions: ["ts", "tsx", "js", "jsx", "mjs", "cjs", "json"],
  // Compile every dependency: more and more ship only ES modules (oRPC, use-intl's
  // formatters), and an allowlist would break each time one does. Babel caches the result.
  transformIgnorePatterns: [],
  // Every source file, screens included. No threshold here: the rule is 100% of every
  // file across all suites, checked on the merged reports (scripts/coverage.ts).
  collectCoverageFrom: ["src/**/*.{ts,tsx}", "!src/**/*.test.{ts,tsx}"],
  coverageReporters: ["text-summary", "lcov"],
};
