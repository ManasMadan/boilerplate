import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { type HookInput, ROOT } from "./lib";
import { suppressions } from "./suppressions";

// Built, so this file names no suppression itself.
const IGNORE = `@ts-${"ignore"}`;

const edit = (
  file: string,
  tool_input: HookInput["tool_input"],
  tool_name = "Edit",
): HookInput => ({
  session_id: "s",
  hook_event_name: "PostToolUse",
  cwd: ROOT,
  tool_name,
  tool_input: { file_path: join(ROOT, file), ...tool_input },
});

describe("the suppressions hook", () => {
  it("blocks an edit that adds one, and says what to do instead", () => {
    const output = suppressions(
      edit("apps/api/src/x.ts", { old_string: "a", new_string: `// ${IGNORE}\na` }),
    );
    expect(output).toEqual({
      decision: "block",
      reason: expect.stringContaining(`apps/api/src/x.ts now has ${IGNORE}`),
    });
  });

  it("allows an edit that keeps one that was already there", () => {
    const text = `// ${IGNORE}\na`;
    expect(
      suppressions(edit("apps/api/src/x.ts", { old_string: text, new_string: `${text}b` })),
    ).toBeUndefined();
  });

  it("compares a whole-file write with the last commit", () => {
    // Not committed: the write adds everything it has.
    const write = edit("apps/api/src/new.ts", { content: `// ${IGNORE}\n` }, "Write");
    expect(suppressions(write)).toMatchObject({ decision: "block" });
    // Committed and unchanged: nothing is added.
    const same = edit("scripts/check-markers.ts", { content: "" }, "Write");
    expect(suppressions(same)).toBeUndefined();
  });

  it("leaves prose, the files that define the patterns, and calls without a file alone", () => {
    expect(suppressions(edit("docs/x.md", { new_string: IGNORE }))).toBeUndefined();
    expect(suppressions(edit("scripts/suppressions.ts", { new_string: IGNORE }))).toBeUndefined();
    expect(suppressions({ ...edit("x.ts", {}), tool_input: {} })).toBeUndefined();
  });
});
