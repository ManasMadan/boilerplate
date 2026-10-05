import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { captureOutput } from "./stand-ins";
import {
  addedSuppressions,
  checkSuppressions,
  countSuppressions,
  listedFiles,
} from "./suppressions";

afterEach(() => mock.restore());

describe("suppressions", () => {
  it.each([
    ["// @ts-ignore", "@ts-ignore"],
    ["// @ts-expect-error untyped", "@ts-expect-error"],
    ["// biome-ignore lint/x: y", "biome-ignore"],
    ["/* v8 ignore next */", "coverage ignore (v8, c8, istanbul)"],
    ["x = 1  # pragma: no cover", "# pragma: no cover"],
    ["x = f()  # type: ignore[attr]", "# type: ignore"],
    ["x = f()  # pyright: ignore[reportAny]", "# pyright: ignore"],
    ["import os  # noqa: F401", "# noqa"],
    ["// type-coverage:ignore-next-line", "type-coverage:ignore"],
    ["it.skip('x', () => {})", "a skipped test (.skip, xit, @pytest.mark.skip)"],
    ["test.skipIf(!env)('x', () => {})", "a skipped test (.skip, xit, @pytest.mark.skip)"],
    ["@pytest.mark.skip(reason='x')", "a skipped test (.skip, xit, @pytest.mark.skip)"],
    ["describe.only('x', () => {})", "a focused test (.only, fit)"],
  ])("%s", (text, kind) => {
    expect([...countSuppressions(text).keys()]).toEqual([kind]);
  });

  it("ignores ordinary code", () => {
    expect(countSuppressions("const skip = items.skip; export function only() {}")).toEqual(
      new Map(),
    );
  });

  it("reports only what an edit adds", () => {
    const before = "a // @ts-expect-error old\n";
    expect(addedSuppressions(before, `${before}b\n`)).toEqual([]);
    expect(addedSuppressions(before, `${before}c // @ts-expect-error new\n`)).toEqual([
      "@ts-expect-error",
    ]);
    expect(addedSuppressions(before, "a\n")).toEqual([]);
  });

  it("reads the files docs/testing.md's tables allow", () => {
    const root = mkdtempSync(join(tmpdir(), "suppressions-"));
    mkdirSync(join(root, "docs"));
    writeFileSync(
      join(root, "docs/testing.md"),
      [
        "## Coverage exceptions",
        "Prose `apps/x.ts` isn't a row.",
        "| File | Why |",
        "|---|---|",
        "| `apps/notifications/test/fake-push.ts:25` | untyped module |",
        "## Type-coverage exceptions",
        "| `packages/contracts/src/api/base.ts` | an object built from keys |",
        "## Not tested automatically",
        "| `apps/y.test.ts` | a table that allows nothing |",
      ].join("\n"),
    );
    expect(listedFiles(root)).toEqual(
      new Set(["apps/notifications/test/fake-push.ts", "packages/contracts/src/api/base.ts"]),
    );
    expect(listedFiles(mkdtempSync(join(tmpdir(), "none-")))).toEqual(new Set());
  });
});

describe("the check over the repository's files", () => {
  it("fails on an unlisted suppression, and passes once docs/testing.md lists the file", async () => {
    const root = mkdtempSync(join(tmpdir(), "suppressions-"));
    await $`git init -q`.cwd(root);
    mkdirSync(join(root, "apps"));
    writeFileSync(join(root, "apps/x.ts"), "// @ts-expect-error untyped\n");
    writeFileSync(join(root, "apps/clean.ts"), "export const a = 1;\n");
    writeFileSync(join(root, "notes.md"), "// @ts-expect-error in prose\n");
    await $`git add .`.cwd(root);
    const printed = captureOutput();
    expect(checkSuppressions(root)).toBe(1);
    expect(printed()).toContain("apps/x.ts: @ts-expect-error");
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs/testing.md"), "## Suppressions\n| `apps/x.ts` | untyped |\n");
    expect(checkSuppressions(root)).toBe(0);
    // A new file counts before it's added, and a deleted one is skipped.
    writeFileSync(join(root, "apps/new.ts"), "// @ts-expect-error new\n");
    rmSync(join(root, "apps/clean.ts"));
    expect(checkSuppressions(root)).toBe(1);
    expect(printed()).toContain("apps/new.ts: @ts-expect-error");
  });
});
