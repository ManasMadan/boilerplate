/**
 * Component tests (React Native Testing Library) on jest-expo's React Native preset.
 * The shared packages ship TypeScript source, so they're transformed like app code.
 */
module.exports = {
  preset: "jest-expo",
  // e2e/ is Playwright's (bun run test:e2e).
  roots: ["<rootDir>/src"],
  setupFiles: ["./jest.setup.ts"],
  moduleNameMapper: { "^@/(.*)$": "<rootDir>/src/$1" },
  transformIgnorePatterns: [
    "node_modules/(?!((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@rn-primitives/.*|uniwind|lucide-react-native|better-auth|@better-auth/.*|@better-fetch/.*|nanostores|@orpc/.*|use-intl|@tanstack/.*|@repo/.*))",
  ],
};
