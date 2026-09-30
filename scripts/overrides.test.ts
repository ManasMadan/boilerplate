import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  overrides?: Record<string, string>;
  patchedDependencies?: Record<string, string>;
};
const skill = readFileSync(join(root, ".claude/skills/dependency-update/SKILL.md"), "utf8");

/** The packages the skill's "Overrides and patches" table documents. */
const documented = new Set([...skill.matchAll(/^\| `([^`]+)` \|/gm)].map(([, name]) => name));

describe("overrides and patches", () => {
  // A forced version or a patch nobody can explain is never dropped: each one says why
  // it's there and when it can go.
  it.each([
    ...Object.keys(manifest.overrides ?? {}),
    // "name@version", where the name may be scoped.
    ...Object.keys(manifest.patchedDependencies ?? {}).map((key) => key.replace(/(.)@.*$/, "$1")),
  ])("documents %s in the dependency-update skill", (name) => {
    expect(documented).toContain(name);
  });
});
