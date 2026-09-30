import { describe, expect, it } from "bun:test";
import { areas, areasOf } from "./changes";

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
