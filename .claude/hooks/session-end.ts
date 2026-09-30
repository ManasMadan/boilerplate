/**
 * SessionEnd: removes the session's state (the tree fingerprint, the re-check count,
 * what it already asked, the hints it had), which would otherwise pile up in
 * .claude/.state.
 */

import { rmSync } from "node:fs";
import { type HookInput, runHook, sessionFiles } from "./lib";

export function sessionEnd(input: HookInput) {
  for (const file of sessionFiles) {
    rmSync(file(input.session_id), { force: true });
  }
  return undefined;
}

if (import.meta.main) process.exit(await runHook(sessionEnd));
