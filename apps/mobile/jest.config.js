/**
 * Unit and component tests (React Native Testing Library) on jest-expo's React Native
 * preset. The shared packages ship TypeScript source and are compiled like app code.
 */
module.exports = {
  preset: "jest-expo",
  // e2e/ is Playwright's (bun run test:e2e).
  roots: ["<rootDir>/src"],
  setupFiles: ["./jest.setup.ts"],
  moduleNameMapper: { "^@/(.*)$": "<rootDir>/src/$1" },
  // Several dependencies ship only ES modules as .mjs (oRPC); Babel compiles them too.
  transform: { "\\.mjs$": "babel-jest" },
  moduleFileExtensions: ["ts", "tsx", "js", "jsx", "mjs", "cjs", "json"],
  // Compile every dependency: more and more ship only ES modules (oRPC, use-intl's
  // formatters), and an allowlist would break each time one does. Babel caches the result.
  transformIgnorePatterns: [],
  // Unit tests cover the app's logic (src/lib); the screens are proved end to end
  // (e2e/). The floor is what the suite meets, less a point; raise it with new tests.
  collectCoverageFrom: ["src/lib/**/*.{ts,tsx}", "!src/lib/**/*.test.{ts,tsx}"],
  coverageReporters: ["text-summary", "lcov"],
  coverageThreshold: { global: { lines: 90, functions: 82, branches: 77, statements: 88 } },
};
