import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionStart } from "./session-start";

/** `bun run doctor` as a stand-in, counting its runs. */
function doctor() {
  const runs: string[][] = [];
  const run = async (command: string[]) => {
    runs.push(command);
    return { exitCode: 0, stdout: "  \x1b[32m✔\x1b[0m Node v24\n", stderr: "" };
  };
  return { run, runs };
}

const context = (output: Record<string, unknown>) =>
  (output.hookSpecificOutput as { additionalContext: string }).additionalContext;

describe("the session's environment check", () => {
  it("runs the doctor and gives Claude its summary, without colours", async () => {
    const cache = join(mkdtempSync(join(tmpdir(), "session-")), "doctor.txt");
    const { run, runs } = doctor();
    const output = await sessionStart(run, cache);
    expect(runs).toEqual([["bun", "scripts/doctor.ts"]]);
    expect(context(output)).toContain("Local environment check (bun run doctor):\n  ✔ Node v24\n");
    expect(readFileSync(cache, "utf8")).toBe("  ✔ Node v24\n");
  });

  it("uses the summary from the last 10 minutes, and runs the doctor again after", async () => {
    const cache = join(mkdtempSync(join(tmpdir(), "session-")), "doctor.txt");
    writeFileSync(cache, "cached\n");
    const { run, runs } = doctor();
    expect(context(await sessionStart(run, cache))).toContain("cached");
    expect(runs).toEqual([]);
    const old = new Date(Date.now() - 11 * 60_000);
    utimesSync(cache, old, old);
    await sessionStart(run, cache);
    expect(runs).toHaveLength(1);
  });
});
