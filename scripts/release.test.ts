import { describe, expect, it } from "bun:test";
import {
  mobileVersion,
  type ReleaseFacts,
  releaseFile,
  releaseImageTag,
  releaseNotes,
} from "./release";

const commit = (subject: string, body = "") => ({ hash: "abc1234", subject, body });

describe("release notes", () => {
  it("groups user-facing commits by type and leaves the rest out", () => {
    const notes = releaseNotes([
      commit("feat(api): share todos"),
      commit("fix: keep the session on refresh"),
      commit("chore(deps): bump zod"),
      commit("docs: explain releases"),
      commit("perf(web): smaller sign-in page"),
      commit("not conventional at all"),
    ]);
    expect(notes).toBe(
      [
        "## Features\n\n- **api:** share todos (abc1234)",
        "## Fixes\n\n- keep the session on refresh (abc1234)",
        "## Performance\n\n- **web:** smaller sign-in page (abc1234)\n",
      ].join("\n\n"),
    );
  });

  it("lists breaking changes first, from `!` or a BREAKING CHANGE footer", () => {
    const notes = releaseNotes([
      commit("feat(api)!: drop v0 routes"),
      commit("fix(auth): shorter sessions", "Details.\n\nBREAKING CHANGE: sessions last a day"),
    ]);
    expect(notes.startsWith("## Breaking changes\n\n- **api:** drop v0 routes")).toBe(true);
    expect(notes).toContain("- **auth:** shorter sessions (abc1234)\n\n## Features");
  });

  it("says so when nothing user-facing changed", () => {
    expect(releaseNotes([commit("chore: tidy")])).toBe(
      "Maintenance only: no user-facing changes.\n",
    );
  });
});

describe("the mobile version", () => {
  it("is read from the app config", () => {
    expect(mobileVersion('export default {\n  name: "App",\n  version: "1.4.0",\n}')).toBe("1.4.0");
    expect(mobileVersion("export default {}")).toBeUndefined();
  });
});

describe("promoting", () => {
  it("pins production to the release's revision and images, keeping the comments", () => {
    const current = "# The release production runs.\n# Written by promote.\nrevision: HEAD\n";
    expect(releaseFile(current, "v1.4.0", "sha-123")).toBe(
      "# The release production runs.\n# Written by promote.\nrevision: v1.4.0\nimageTag: sha-123\n",
    );
  });

  it("writes what the envs ApplicationSet reads", () => {
    const release = Bun.YAML.parse(releaseFile("revision: v1.0.0\n", "v1.4.0", "sha-1")) as object;
    expect(release).toEqual({ revision: "v1.4.0", imageTag: "sha-1" });
  });
});

describe("a release's images", () => {
  const STAGING = "deploy/environments/staging/stack.yaml";
  // master: merge (deployed) ← bump ([skip ci], repoints staging at the merge's images).
  const facts = (overrides: Partial<ReleaseFacts> = {}): ReleaseFacts => ({
    deployed: (commit) => commit === "merge",
    changedFiles: (commit) => (commit === "bump" ? [STAGING] : ["apps/api/src/main.ts"]),
    parent: (commit) => (commit === "bump" ? "merge" : "older"),
    stagingTag: (commit) => (commit === "bump" ? "sha-merge" : "sha-older"),
    ...overrides,
  });

  it("are the commit's own once deploy.yml passed for it", () => {
    expect(releaseImageTag("merge", facts())).toBe("sha-merge");
  });

  it("are the parent's for the staging bump right after it", () => {
    expect(releaseImageTag("bump", facts())).toBe("sha-merge");
  });

  it("don't exist for a commit that never deployed", () => {
    expect(releaseImageTag("older", facts())).toBeUndefined();
  });

  it("aren't borrowed by a bump that changes anything else, or points elsewhere", () => {
    expect(
      releaseImageTag("bump", facts({ changedFiles: () => [STAGING, "apps/api/src/main.ts"] })),
    ).toBeUndefined();
    expect(releaseImageTag("bump", facts({ stagingTag: () => "sha-older" }))).toBeUndefined();
    expect(releaseImageTag("bump", facts({ deployed: () => false }))).toBeUndefined();
  });
});
