import { coverage } from "@repo/vitest-config";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { coverage: coverage({ lines: 7, functions: 17, branches: 37, statements: 8 }) },
});
