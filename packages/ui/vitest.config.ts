/**
 * The stories as tests, in a real browser (Chromium through Playwright): each renders,
 * runs its play function, and must have no accessibility violations, once in the light
 * theme and once in the dark one (contrast problems are often in one only).
 */
import { fileURLToPath } from "node:url";
import { coverage } from "@repo/vitest-config";
import { storybookTest } from "@storybook/addon-vitest/vitest-plugin";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

const configDir = fileURLToPath(new URL(".storybook", import.meta.url));
// A fresh object per project: Vitest records each project's name on its instances.
const browser = () => ({
  enabled: true,
  headless: true,
  provider: playwright(),
  instances: [{ browser: "chromium" as const }],
});

export default defineConfig({
  test: {
    // In the browser too: Chromium reports V8 coverage like Node.
    coverage: coverage(),
    projects: (["light", "dark"] as const).map((theme) => ({
      plugins: [storybookTest({ configDir })],
      define: { "import.meta.env.VITE_STORY_THEME": JSON.stringify(theme) },
      test: { name: `stories (${theme})`, browser: browser() },
    })),
  },
});
