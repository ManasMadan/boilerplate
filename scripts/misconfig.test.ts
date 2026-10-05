import { afterEach, describe, expect, it, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./lib";
import { misconfig, misconfigReads, TRIVY_VERSION } from "./misconfig";
import { captureOutput, fakeRun } from "./stand-ins";

afterEach(() => mock.restore());

describe("the misconfiguration scan", () => {
  it("uses a local trivy of CI's version, with a cache of its own, and fails as it does", () => {
    const { run, calls, options } = fakeRun((line) => {
      if (line === "trivy --version") {
        return { stdout: `Version: ${TRIVY_VERSION}\n` };
      }
      return line.startsWith("trivy config") ? { status: 1 } : {};
    });
    expect(misconfig(run, "/repo", "/cache")).toBe(1);
    expect(calls).toEqual(["trivy --version", "trivy config --quiet . --cache-dir /cache"]);
    expect(options.at(-1)).toEqual({ cwd: "/repo", stdio: "inherit" });
  });

  it("runs its image when the local trivy is another version, or missing", () => {
    for (const local of [{ stdout: "Version: 0.1.0\n" }, { status: null }]) {
      const { run, calls } = fakeRun((line) => (line === "trivy --version" ? local : {}));
      expect(misconfig(run, "/repo")).toBe(0);
      expect(calls.at(-1)).toBe(
        `docker run --rm --memory=512m -v /repo:/repo:ro -w /repo aquasec/trivy:${TRIVY_VERSION} config --quiet .`,
      );
    }
  });

  it("fails rather than skipping when there's neither, and when trivy can't start", () => {
    const printed = captureOutput();
    expect(misconfig(fakeRun(() => ({ status: 1 })).run)).toBe(1);
    expect(printed()).toContain("isn't installed and Docker isn't running");
    const { run } = fakeRun((line) => (line.startsWith("docker run") ? { status: null } : {}));
    expect(misconfig(run)).toBe(1);
  });

  it.each([
    ["deploy/docker/web.Dockerfile", true],
    [".devcontainer/Dockerfile", true],
    ["deploy/platform/jaeger/values.yaml", true],
    ["infra/tofu/envs/k3s/main.tf", true],
    ["trivy.yaml", true],
    [".trivyignore.yaml", true],
    ["apps/api/src/main.ts", false],
    ["docs/deploy.md", false],
  ])("reads %s: %p", (path, reads) => {
    expect(misconfigReads(path)).toBe(reads);
  });

  it("is CI's scan: the same Trivy, and trivy.yaml deciding the rest", () => {
    const security = readFileSync(join(ROOT, ".github/workflows/security.yml"), "utf8");
    const job = security.slice(
      security.indexOf("  misconfig:"),
      security.indexOf("  security-ok:"),
    );
    expect(job).toContain(`version: v${TRIVY_VERSION}\n`);
    expect(job).toContain("trivy-config: trivy.yaml\n");
    for (const input of ["exit-code:", "skip-dirs:", "severity:", "trivyignores:"]) {
      expect(job).not.toContain(input);
    }
    const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
    expect(ci).toContain(`TRIVY: aquasec/trivy:${TRIVY_VERSION}\n`);
  });
});
