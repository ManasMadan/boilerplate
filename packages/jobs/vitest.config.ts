import { coverage } from "@repo/vitest-config";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { coverage: coverage({ lines: 74, functions: 41, branches: 44, statements: 73 }) },
});
