import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runAll, STEPS } from "./lint";

describe("bun run lint", () => {
  it("runs every step after one fails, and reports each failure", () => {
    const ran: string[] = [];
    const failed = runAll([["a"], ["b"], ["c"]], ([name = ""]) => {
      ran.push(name);
      return name === "c" ? 0 : 1;
    });
    expect(ran).toEqual(["a", "b", "c"]);
    expect(failed).toEqual([["a"], ["b"]]);
  });

  it("is the script package.json and CI's lint job run", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "../package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.lint).toBe("bun scripts/lint.ts");
    const ci = readFileSync(join(import.meta.dir, "../.github/workflows/ci.yml"), "utf8");
    expect(ci).toContain("- run: bun run lint\n");
    expect(STEPS.map((step) => step.join(" "))).toContain("bunx turbo run lint");
  });
});
