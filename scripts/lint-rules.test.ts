/**
 * The coding standards Biome enforces for the whole repo (biome.jsonc): each one refuses
 * the code it exists to keep out. One Biome run over a temporary folder of samples,
 * checked against the repo's configuration, so turning a rule off or down fails here.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./lib";

/** A sample that breaks one rule, by the rule's Biome category. */
const SAMPLES: Record<string, string> = {
  "lint/style/noParameterAssign": `export function f(a: number) {
  a = 2;
  return a;
}
`,
  "lint/complexity/noUselessCatch": `export function f(g: () => void) {
  try {
    g();
  } catch (error) {
    throw error;
  }
}
`,
  "lint/style/noNestedTernary": `export const size = (n: number) => (n > 10 ? "big" : n > 5 ? "medium" : "small");
`,
  "lint/style/noRestrictedImports": `import { z } from "zod";

export const name = z.string();
`,
};

/** A sample every rule accepts. */
const CLEAN = `import * as z from "zod";

export function f(a: number) {
  const b = a + 1;
  return z.number().parse(b);
}
`;

type Diagnostic = { category: string; location: { path: string } };

let folder = "";
let diagnostics: Diagnostic[] = [];

beforeAll(() => {
  folder = mkdtempSync(join(tmpdir(), "lint-rules-"));
  Object.values(SAMPLES).forEach((code, index) => {
    writeFileSync(join(folder, `sample${index}.ts`), code);
  });
  writeFileSync(join(folder, "clean.ts"), CLEAN);
  const ran = Bun.spawnSync(
    ["bunx", "biome", "lint", "--reporter=json", `--config-path=${ROOT}`, folder],
    { cwd: ROOT },
  );
  // Biome's own report, in a test: a wrong shape fails the assertions below.
  diagnostics = (JSON.parse(ran.stdout.toString()) as { diagnostics: Diagnostic[] }).diagnostics;
});

afterAll(() => rmSync(folder, { recursive: true, force: true }));

describe("Biome's coding standards", () => {
  it.each(Object.keys(SAMPLES).map((category, index) => [category, index] as const))(
    "%s refuses its sample",
    (category, index) => {
      const found = diagnostics
        .filter(({ location }) => location.path.endsWith(`sample${index}.ts`))
        .map((diagnostic) => diagnostic.category);
      expect(found).toContain(category);
    },
  );

  it("accepts code that follows them", () => {
    expect(diagnostics.filter(({ location }) => location.path.endsWith("clean.ts"))).toEqual([]);
  });
});
