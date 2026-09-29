import { coverage } from "@repo/vitest-config";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { coverage: coverage({ lines: 4, functions: 9, branches: 13, statements: 5 }) },
});
