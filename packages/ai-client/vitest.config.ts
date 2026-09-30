/** Its tests are the api's (apps/api), which report this package's coverage too. */
import { coverage } from "@repo/vitest-config";
import { defineConfig } from "vitest/config";

export default defineConfig({ test: { coverage: coverage() } });
