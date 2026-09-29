import { describe, expect, it } from "bun:test";
import { mobileVersion, releaseNotes, withImageTag } from "./release";

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
  const values = '# Production.\nimage:\n  tag: ""\nsite:\n  host: app.example.com\n  tag: other\n';

  it("sets image.tag and nothing else", () => {
    expect(withImageTag(values, "sha-123")).toBe(
      '# Production.\nimage:\n  tag: "sha-123"\nsite:\n  host: app.example.com\n  tag: other\n',
    );
  });

  it("finds the tag among image's other keys", () => {
    const more = 'image:\n  pullPolicy: IfNotPresent\n  tag: "sha-old"\nsite: {}\n';
    expect(withImageTag(more, "sha-new")).toBe(
      'image:\n  pullPolicy: IfNotPresent\n  tag: "sha-new"\nsite: {}\n',
    );
  });

  it("refuses values without an image.tag", () => {
    expect(() => withImageTag("site:\n  host: a\n", "sha-1")).toThrow("No image.tag");
  });
});
