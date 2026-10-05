import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { imageFiles, imageReferences, imageScan, thirdPartyImages } from "./image-scan";
import { TRIVY_VERSION } from "./misconfig";
import { captureOutput, fakeRun } from "./stand-ins";

afterEach(() => mock.restore());

const VALKEY = `valkey/valkey:9.1.2-alpine@sha256:${"a".repeat(64)}`;

/** A checkout naming images in values, a test, a compose file and the dev container. */
function checkout() {
  const root = mkdtempSync(join(tmpdir(), "image-scan-"));
  mkdirSync(join(root, "deploy/charts/data/tests"), { recursive: true });
  mkdirSync(join(root, ".devcontainer"));
  writeFileSync(
    join(root, "deploy/charts/data/values.yaml"),
    `valkey:\n  image: docker.io/${VALKEY}\n  # image: commented/out:1\n  imageName: "ghcr.io/x/pg:18@sha256:${"b".repeat(64)}"\n`,
  );
  writeFileSync(join(root, "deploy/charts/data/tests/t.yaml"), "image: test/only:1\n");
  writeFileSync(
    join(root, "docker-compose.yml"),
    `services:\n  valkey:\n    image: ${VALKEY}\n  app:\n    image: boilerplate/api:dev\n`,
  );
  writeFileSync(
    join(root, ".devcontainer/Dockerfile"),
    `FROM oven/bun:1@sha256:${"c".repeat(64)} AS bun\nFROM base:2@sha256:${"d".repeat(64)}\n`,
  );
  return root;
}

describe("the third-party images", () => {
  it("are every image deploy/, compose and the dev container name, each once, ours aside", () => {
    const root = checkout();
    expect(imageFiles(root).sort()).toEqual([
      "deploy/charts/data/values.yaml",
      "docker-compose.yml",
    ]);
    expect(imageReferences(root)).toHaveLength(4);
    expect(thirdPartyImages(root)).toEqual([
      `base:2@sha256:${"d".repeat(64)}`,
      `ghcr.io/x/pg:18@sha256:${"b".repeat(64)}`,
      `oven/bun:1@sha256:${"c".repeat(64)}`,
      VALKEY,
    ]);
  });

  it("include this repository's, all of them pinned", () => {
    expect(thirdPartyImages().length).toBeGreaterThan(15);
    expect(thirdPartyImages().every((ref) => /@sha256:[0-9a-f]{64}$/.test(ref))).toBe(true);
  });
});

describe("the image scan", () => {
  const trivy = (line: string) =>
    line === "trivy --version" ? { stdout: `Version: ${TRIVY_VERSION}\n` } : undefined;

  it("scans each image from its registry, as CI scans ours, and fails on any", () => {
    const printed = captureOutput();
    const root = checkout();
    const { run, calls } = fakeRun(
      (line) => trivy(line) ?? (line.includes("ghcr.io/x/pg") ? { status: 1 } : {}),
    );
    expect(imageScan([], run, root, "/cache")).toBe(1);
    const scans = calls.filter((line) => line.startsWith("trivy image"));
    expect(scans).toHaveLength(4);
    expect(scans[0]).toBe(
      `trivy image --quiet --scanners vuln --exit-code 1 --ignore-unfixed --severity CRITICAL,HIGH --ignorefile ${root}/.trivyignore.yaml --image-src remote --db-repository mirror.gcr.io/aquasec/trivy-db base:2@sha256:${"d".repeat(64)} --cache-dir /cache`,
    );
    expect(printed()).toContain("1 of 4 images have a fixable critical or high vulnerability");
  });

  it("scans only the images it's given, through Trivy's image when there's no local one", () => {
    captureOutput();
    const { run, calls } = fakeRun((line) => (line === "trivy --version" ? { status: null } : {}));
    expect(imageScan(["a/b:1"], run, "/repo", "/cache")).toBe(0);
    expect(calls.at(-1)).toStartWith(
      `docker run --rm --memory=1g -v /repo:/repo:ro -v /cache:/root/.cache/trivy aquasec/trivy:${TRIVY_VERSION} image `,
    );
    expect(calls.at(-1)).toEndWith(" a/b:1");
  });

  it("fails rather than skipping when there's neither Trivy nor Docker", () => {
    const printed = captureOutput();
    expect(imageScan(["a/b:1"], fakeRun(() => ({ status: 1 })).run, "/repo")).toBe(1);
    expect(printed()).toContain("isn't installed and Docker isn't running");
  });
});
