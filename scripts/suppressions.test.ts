import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addedSuppressions, countSuppressions, listedFiles } from "./suppressions";

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
      "Prose `apps/x.ts` isn't a row.\n\n| File | Why |\n|---|---|\n| `apps/notifications/test/fake-push.ts:25` | untyped module |\n",
    );
    expect(listedFiles(root)).toEqual(new Set(["apps/notifications/test/fake-push.ts"]));
    expect(listedFiles(mkdtempSync(join(tmpdir(), "none-")))).toEqual(new Set());
  });
});
