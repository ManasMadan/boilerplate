import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { type FileCoverage, isSource, mergeLcov, misses, toLcov } from "./coverage";

const ROOT = join(import.meta.dir, "..");

const report = (path: string, body: string[]) =>
  [`SF:${path}`, ...body, "end_of_record"].join("\n");

describe("merging coverage", () => {
  it("adds up what every suite saw of a file, so shared code gets credit from its callers", () => {
    const coverage = new Map<string, FileCoverage>();
    // The package's own tests reach one branch; an app's tests reach the other.
    mergeLcov(
      coverage,
      report("src/lib.ts", [
        "FN:1,run",
        "FNDA:1,run",
        "BRDA:2,0,0,1",
        "BRDA:2,0,1,0",
        "DA:1,1",
        "DA:3,0",
      ]),
      join(ROOT, "packages/pkg"),
    );
    mergeLcov(
      coverage,
      report(join(ROOT, "packages/pkg/src/lib.ts"), [
        "FN:1,run",
        "FNDA:0,run",
        "BRDA:2,0,1,2",
        "DA:3,4",
      ]),
      join(ROOT, "apps/app"),
    );
    const file = coverage.get("packages/pkg/src/lib.ts") as FileCoverage;
    expect(misses(file)).toEqual({ lines: [], branches: [], functions: [] });
    expect(file.lines.get(3)).toBe(4);
  });

  it("names what's left: lines, the lines of branches never taken, and functions never called", () => {
    const coverage = mergeLcov(
      new Map(),
      report("src/a.ts", ["FN:5,never", "FNDA:0,never", "BRDA:7,0,0,-", "DA:5,0", "DA:6,1"]),
      join(ROOT, "packages/pkg"),
    );
    expect(misses(coverage.get("packages/pkg/src/a.ts") as FileCoverage)).toEqual({
      lines: [5],
      branches: [7],
      functions: ["never"],
    });
  });

  it("reads coverage.py's functions, which give their end line too", () => {
    const coverage = mergeLcov(
      new Map(),
      report("app/usage.py", ["FN:47,57,settle", "FNDA:3,settle", "DA:47,3"]),
      join(ROOT, "apps/ai"),
    );
    expect(misses(coverage.get("apps/ai/app/usage.py") as FileCoverage).functions).toEqual([]);
  });

  it("writes the merged report back as LCOV that reads the same", () => {
    const coverage = mergeLcov(
      new Map(),
      report("src/a.ts", ["FN:1,f", "FNDA:2,f", "BRDA:1,0,0,1", "DA:1,2"]),
      join(ROOT, "packages/pkg"),
    );
    const again = mergeLcov(new Map(), toLcov(coverage), ROOT);
    expect(again).toEqual(coverage);
  });
});

describe("which files the rule applies to", () => {
  it.each([
    ["apps/api/src/server.ts", true],
    ["apps/ai/app/main.py", true],
    ["packages/client/src/errors.ts", true],
    ["scripts/release.ts", true],
    [".claude/hooks/lib.ts", true],
    ["apps/api/src/server.test.ts", false],
    ["apps/web/e2e/auth.spec.ts", false],
    ["apps/api/src/generated/client.ts", false],
    ["packages/ai-client/src/generated/types.gen.ts", false],
    ["apps/ai/tests/test_errors.py", false],
    ["apps/api/vitest.config.ts", false],
  ])("%s → %s", (path, expected) => {
    expect(isSource(path)).toBe(expected);
  });
});
