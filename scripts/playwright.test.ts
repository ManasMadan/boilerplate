/**
 * The end-to-end suites retry in CI only to tell a flaky test from a broken one: a test
 * that passed only on a retry still fails the run, or retries would hide it.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const configs = ["apps/web/playwright.config.ts", "apps/mobile/playwright.config.ts"];

describe("the Playwright suites", () => {
  it.each(configs)("%s fails the run on a flaky test in CI", (file) => {
    const config = readFileSync(join(import.meta.dir, "..", file), "utf8");
    expect(config).toContain("failOnFlakyTests: Boolean(process.env.CI)");
  });
});
