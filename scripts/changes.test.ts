import { afterEach, describe, expect, it, mock } from "bun:test";
import { areas, areasOf, main } from "./changes";
import { captureOutput, fakeRun } from "./stand-ins";

afterEach(() => mock.restore());

const none = { app: false, charts: false, infra: false, images: false, scripts: false };

describe("which CI jobs a pull request needs", () => {
  it("runs none of the heavy ones for docs", () => {
    expect(areas(["docs/deploy.md", "README.md", "deploy/README.md", "LICENSE"])).toEqual(none);
  });

  it("runs the charts and the scripts' tests, not the app's, for a promotion", () => {
    expect(areas(["deploy/environments/production/release.yaml"])).toEqual({
      ...none,
      charts: true,
      scripts: true,
    });
  });

  it("runs OpenTofu's checks for infra/tofu", () => {
    expect(areasOf("infra/tofu/modules/k3s/main.tf")).toEqual(["infra", "scripts"]);
  });

  it("builds the images for a Dockerfile", () => {
    expect(areasOf("deploy/docker/web.Dockerfile")).toEqual(["images"]);
  });

  it("checks both for what the bootstrap and charts:check share", () => {
    expect(areasOf("deploy/argocd/argo-cd-values.yaml")).toEqual(["charts", "infra", "scripts"]);
  });

  it("runs the app's for any source change", () => {
    expect(areasOf("apps/api/src/main.ts")).toEqual(["app"]);
    expect(areasOf("packages/ui/src/button.tsx")).toEqual(["app"]);
  });

  it("checks the Claude setup's own markdown", () => {
    expect(areasOf(".claude/skills/release/SKILL.md")).toEqual(["scripts"]);
  });

  it("runs everything when CI, the toolchain or the lockfile change", () => {
    for (const file of [
      ".github/workflows/ci.yml",
      "bun.lock",
      "package.json",
      "scripts/changes.ts",
    ]) {
      expect(areas([file])).toEqual({
        app: true,
        charts: true,
        infra: true,
        images: true,
        scripts: true,
      });
    }
  });
});

describe("the command", () => {
  it("prints each area for the files changed since the base, or all of them without one", () => {
    const printed = captureOutput();
    const { run, calls } = fakeRun(() => ({ stdout: "docs/testing.md\n" }));
    expect(main("origin/master", run)).toBe(0);
    expect(calls).toEqual(["git diff --name-only origin/master HEAD"]);
    expect(printed()).toContain("app=false");
    expect(main(undefined, run)).toBe(0);
    expect(printed()).toContain("app=true");
  });

  it("fails when git can't diff against the base", () => {
    const printed = captureOutput();
    expect(main("nowhere", fakeRun(() => ({ status: 128, stderr: "bad revision" })).run)).toBe(1);
    expect(printed()).toContain("git diff against nowhere failed: bad revision");
  });
});
