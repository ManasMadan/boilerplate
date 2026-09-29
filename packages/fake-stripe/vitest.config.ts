import { coverage } from "@repo/vitest-config";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { coverage: coverage({ lines: 8, functions: 6, branches: 1, statements: 7 }) },
});
