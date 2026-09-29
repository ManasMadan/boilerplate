/**
 * End-to-end tests: a real browser against the running stack (web + api + notifications,
 * with Mailpit catching email). Locally, start it with `bun dev` and run
 * `bun run test:e2e`; CI starts the built services first.
 */
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  // Each step crosses browser, Next, the API, Postgres, Redis and sometimes the email
  // queue; under parallel load 5s (the default) is too tight for that round trip.
  expect: { timeout: 10_000 },
  // Multi-device flows (invite by email, accept, switch) take several round trips.
  timeout: 60_000,
  fullyParallel: true,
  // Each worker drives up to two browsers against one machine running the whole stack;
  // more than this starves the services and measures the laptop, not the app.
  workers: process.env.CI ? 2 : 4,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
    locale: "en-US",
    // Matches the server's default zone, so the first page load doesn't refresh to
    // record a different one (a test in platform.spec.ts covers that path).
    timezoneId: "UTC",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
