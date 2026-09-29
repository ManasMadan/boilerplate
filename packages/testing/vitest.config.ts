import { coverage } from "@repo/vitest-config";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { coverage: coverage({ lines: 99, functions: 99, branches: 59, statements: 99 }) },
});
