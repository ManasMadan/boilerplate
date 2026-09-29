/**
 * End-to-end tests of the app's own screens, rendered for the web (react-native-web)
 * against the real stack: `bun run test:e2e` at the root builds the web version, serves
 * it with the API on its origin (scripts/serve-web.ts) and runs these. Native-only
 * behaviour (push tokens, secure storage, deep links from the OS) is in the Maestro flows
 * under maestro/, which need a simulator or a device.
 */
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  expect: { timeout: 10_000 },
  timeout: 60_000,
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: process.env.E2E_MOBILE_URL ?? "http://localhost:3100",
    trace: "retain-on-failure",
    locale: "en-US",
    timezoneId: "UTC",
  },
  // A phone-sized viewport: the layout the app is designed for.
  projects: [{ name: "mobile", use: { ...devices["Pixel 7"] } }],
});
