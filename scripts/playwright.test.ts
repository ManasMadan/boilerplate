/**
 * The end-to-end suites retry in CI only to tell a flaky test from a broken one: a test
 * that passed only on a retry still fails the run, or retries would hide it.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const manifest = (path: string) =>
  JSON.parse(readFileSync(join(ROOT, path), "utf8")) as {
    scripts: Record<string, string>;
    devDependencies: Record<string, string>;
  };

const configs = ["apps/web/playwright.config.ts", "apps/mobile/playwright.config.ts"];

describe("the Playwright suites", () => {
  it.each(configs)("%s fails the run on a flaky test in CI", (file) => {
    const config = readFileSync(join(ROOT, file), "utf8");
    expect(config).toContain("failOnFlakyTests: Boolean(process.env.CI)");
  });
});

// Claude Code drives a browser with Playwright's CLI and reads traces through Playwright's
// official skills, installed into .claude/skills by its own commands. Both come from the
// root's playwright-core, which has to be the e2e suites' version (and so use their
// browsers), and the committed skills have to be that version's.
describe("the Playwright CLI", () => {
  const root = manifest("package.json");
  const PLAYWRIGHT_SKILLS = ["playwright-cli", "playwright-trace"];
  const files = (dir: string) =>
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
      .sort();

  it("is the version the e2e suites run", () => {
    expect(root.devDependencies["playwright-core"]).toBe(
      manifest("apps/web/package.json").devDependencies["@playwright/test"],
    );
  });

  it.each(PLAYWRIGHT_SKILLS)("comes with the installed version's %s skill", (skill) => {
    const installed = join(ROOT, "node_modules/playwright-core/lib/tools/skills", skill);
    const committed = join(ROOT, ".claude/skills", skill);
    const fix =
      "Reinstall Playwright's skills: rm -r .claude/skills/playwright-* && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 .claude/bin/playwright-cli install --skills && npx playwright trace install-skill";
    expect(files(committed), fix).toEqual(files(installed));
    for (const file of files(installed)) {
      expect(readFileSync(join(committed, file), "utf8"), `${file}: ${fix}`).toBe(
        readFileSync(join(installed, file), "utf8"),
      );
    }
  });
});
