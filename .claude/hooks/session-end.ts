/**
 * SessionEnd: removes the session's turn state (the tree fingerprint, the re-check
 * count, what it already asked), which would otherwise pile up in .claude/.state.
 */

import { rmSync } from "node:fs";
import { askedFile, type HookInput, runHook, stopCountFile, turnFile } from "./lib";

export function sessionEnd(input: HookInput) {
  for (const file of [turnFile, stopCountFile, askedFile]) {
    rmSync(file(input.session_id), { force: true });
  }
  return undefined;
}

if (import.meta.main) process.exit(await runHook(sessionEnd));
