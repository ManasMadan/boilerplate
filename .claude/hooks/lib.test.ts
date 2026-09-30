import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { changedFiles, defaultBranch, treeFingerprint } from "./lib";

let repo: string;
beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), "hooks-"));
  await $`git init -q -b main && git config user.email t@example.com && git config user.name t`.cwd(
    repo,
  );
  writeFileSync(join(repo, "tracked.ts"), "// one\n");
  await $`git add . && git commit -qm init`.cwd(repo);
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe("the working tree's fingerprint", () => {
  it("changes when an already changed line changes again", async () => {
    writeFileSync(join(repo, "tracked.ts"), "// two\n");
    const before = await treeFingerprint(repo);
    writeFileSync(join(repo, "tracked.ts"), "// six\n");
    expect(await treeFingerprint(repo)).not.toBe(before);
  });

  it("changes when an untracked file is rewritten", async () => {
    writeFileSync(join(repo, "new.ts"), "export const a = 1;\n");
    const before = await treeFingerprint(repo);
    writeFileSync(join(repo, "new.ts"), "export const a: string = 1;\n");
    expect(await treeFingerprint(repo)).not.toBe(before);
  });

  it("stays the same when nothing changed", async () => {
    expect(await treeFingerprint(repo)).toBe(await treeFingerprint(repo));
  });
});

describe("changed files", () => {
  it("lists edits and new files, not deletions", async () => {
    writeFileSync(join(repo, "tracked.ts"), "// two\n");
    writeFileSync(join(repo, "new.ts"), "\n");
    expect(await changedFiles(repo)).toEqual(["new.ts", "tracked.ts"]);
    rmSync(join(repo, "tracked.ts"));
    expect(await changedFiles(repo)).toEqual(["new.ts"]);
  });
});

describe("the default branch", () => {
  it("is origin's HEAD, or master without a remote", async () => {
    expect(await defaultBranch(repo)).toBe("master");
    await $`git update-ref refs/remotes/origin/main HEAD && git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main`.cwd(
      repo,
    );
    expect(await defaultBranch(repo)).toBe("main");
  });
});
