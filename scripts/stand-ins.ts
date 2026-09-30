/**
 * Stand-ins for the scripts' tests: commands that are recorded instead of run (a test
 * never starts Docker, kind or psql), and console output captured instead of printed.
 */

import { spyOn } from "bun:test";
import type { SpawnSyncOptions } from "node:child_process";
import type { Ran, Run } from "./lib";

/**
 * A `Run` that records each command line (words joined by spaces) and its options, and
 * answers with what `answer` returns for that line: exit 0 and no output unless it says.
 */
export function fakeRun(answer: (line: string) => Partial<Ran> | undefined = () => undefined) {
  const calls: string[] = [];
  const options: SpawnSyncOptions[] = [];
  const run: Run = (command, args, given = {}) => {
    const line = [command, ...args].join(" ");
    calls.push(line);
    options.push(given);
    return { status: 0, stdout: "", stderr: "", ...answer(line) };
  };
  return { run, calls, options };
}

/** Captures console.log and console.error (mock.restore() puts them back); what was printed. */
export function captureOutput(): () => string {
  const log = spyOn(console, "log").mockImplementation(() => undefined);
  const error = spyOn(console, "error").mockImplementation(() => undefined);
  return () => [...log.mock.calls, ...error.mock.calls].flat().join("\n");
}
