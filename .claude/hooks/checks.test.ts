import { describe, expect, it } from "bun:test";
import { checksFor, touchesEverything } from "./checks";

const labels = (changed: string[]) => checksFor(changed).map((check) => check.label);

describe("the Stop hook's checks", () => {
  it("run Biome on changed code and turbo for the packages", () => {
    expect(labels(["apps/api/src/main.ts"])).toEqual([
      "Biome on the changed files",
      "lint, types and unit tests of the affected packages",
      "knip",
    ]);
    const biome = checksFor(["apps/api/src/main.ts", "docs/x.md"])[0];
    expect(biome?.command.slice(-1)).toEqual(["apps/api/src/main.ts"]);
  });

  it("check scripts/ and the hooks themselves, which turbo can't see", () => {
    expect(labels(["scripts/lib.ts"])).toEqual([
      "Biome on the changed files",
      "types of scripts/",
      "tests of scripts/ and the hooks",
      "knip",
    ]);
    const hooks = checksFor([".claude/hooks/lib.ts"]);
    expect(hooks.map((check) => check.command.join(" "))).toContain("bunx tsc -p .claude/hooks");
    expect(hooks.find((check) => check.command[0] === "bun")?.command).toEqual([
      "bun",
      "test",
      "./.claude/hooks/",
    ]);
  });

  it("run nothing for a change no check covers", () => {
    expect(labels(["docs/testing.md"])).toEqual([]);
  });

  it("know which changes every package depends on", () => {
    expect(touchesEverything(["bun.lock"])).toBe(true);
    expect(touchesEverything(["apps/api/package.json"])).toBe(false);
  });
});
