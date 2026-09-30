import { describe, expect, it } from "bun:test";
import { findMarkers } from "./check-markers";

describe("the marker check", () => {
  it("reports each marked line of a source file, with its line number", () => {
    const text = "const a = 1;\n// ponytail: a global lock\nconst b = 2;\n  # ponytail: naive\n";
    expect(findMarkers("apps/api/src/x.ts", text)).toEqual([
      "apps/api/src/x.ts:2: // ponytail: a global lock",
      "apps/api/src/x.ts:4: # ponytail: naive",
    ]);
    expect(findMarkers("apps/ai/app/x.py", "# ponytail: naive\n")).toHaveLength(1);
  });

  it("passes clean source", () => {
    expect(findMarkers("apps/api/src/x.ts", "// A count check, not a lock.\n")).toEqual([]);
    expect(findMarkers("apps/api/src/x.ts", "const ponytails = 2;\n")).toEqual([]);
  });

  it("ignores prose and the files that define the marker", () => {
    expect(findMarkers("docs/testing.md", "ponytail: x\n")).toEqual([]);
    expect(findMarkers("scripts/check-markers.ts", "// ponytail: x\n")).toEqual([]);
    expect(findMarkers("scripts/check-markers.test.ts", "// ponytail: x\n")).toEqual([]);
  });
});
