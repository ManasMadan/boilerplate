import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEVCONTAINER,
  ignoreFile,
  imageFiles,
  imageReferences,
  imageScan,
  thirdPartyImages,
} from "./image-scan";
import { ROOT } from "./lib";
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
  it("are every image deploy/ and compose name, each once, ours aside", () => {
    const root = checkout();
    expect(imageFiles(root).sort()).toEqual([
      "deploy/charts/data/values.yaml",
      "docker-compose.yml",
    ]);
    expect(imageReferences(root)).toHaveLength(4);
    expect(thirdPartyImages(root)).toEqual([`ghcr.io/x/pg:18@sha256:${"b".repeat(64)}`, VALKEY]);
  });

  it("include this repository's, all of them pinned", () => {
    expect(thirdPartyImages().length).toBeGreaterThan(14);
    expect(thirdPartyImages().every((ref) => /@sha256:[0-9a-f]{64}$/.test(ref))).toBe(true);
  });
});

describe("the reviewed exceptions", () => {
  // Each one is a wait for an upstream rebuild: it says what and why, and it lapses soon,
  // so the scan fails again and someone looks.
  it("name the vulnerability, say why, and expire within two months", () => {
    const files = readdirSync(join(ROOT, ".trivyignores"), {
      recursive: true,
      encoding: "utf8",
    }).filter((path) => path.endsWith(".yaml"));
    expect(files.length).toBeGreaterThan(0);
    const latest = Date.now() + 62 * 24 * 60 * 60 * 1000;
    for (const file of files) {
      const { vulnerabilities } = Bun.YAML.parse(
        readFileSync(join(ROOT, ".trivyignores", file), "utf8"),
      ) as { vulnerabilities: { id?: string; statement?: string; expired_at?: string }[] };
      for (const entry of vulnerabilities) {
        expect({ file, ok: Boolean(entry.id && entry.statement && entry.expired_at) }).toEqual({
          file,
          ok: true,
        });
        expect(new Date(String(entry.expired_at)).getTime()).toBeLessThanOrEqual(latest);
      }
    }
  });

  it("are found by image repository, whatever the tag or digest", () => {
    expect(ignoreFile("/r", `docker.io/clamav/clamav-debian:1.5.4@sha256:${"a".repeat(64)}`)).toBe(
      "/r/.trivyignores/clamav/clamav-debian.yaml",
    );
    expect(ignoreFile("/r", "registry:5000/team/app:2")).toBe(
      "/r/.trivyignores/registry:5000/team/app.yaml",
    );
  });
});

describe("the image scan", () => {
  const trivy = (line: string) =>
    line === "trivy --version" ? { stdout: `Version: ${TRIVY_VERSION}\n` } : undefined;

  it("scans each image from its registry and the dev container as built, failing on any", () => {
    const printed = captureOutput();
    const root = checkout();
    mkdirSync(join(root, ".trivyignores/ghcr.io/x"), { recursive: true });
    writeFileSync(join(root, ".trivyignores/ghcr.io/x/pg.yaml"), "vulnerabilities: []\n");
    const { run, calls } = fakeRun(
      (line) => trivy(line) ?? (line.includes("ghcr.io/x/pg") ? { status: 1 } : {}),
    );
    expect(imageScan([], run, root, "/cache")).toBe(1);
    expect(calls).toContain(`docker build --quiet -t ${DEVCONTAINER} .devcontainer`);
    const scans = calls.filter((line) => line.startsWith("trivy image"));
    expect(scans).toHaveLength(3);
    // Its own reviewed exceptions, when it has any.
    expect(scans[0]).toBe(
      `trivy image --quiet --scanners vuln --exit-code 1 --ignore-unfixed --severity CRITICAL,HIGH --ignorefile ${root}/.trivyignores/ghcr.io/x/pg.yaml --image-src remote --db-repository mirror.gcr.io/aquasec/trivy-db ghcr.io/x/pg:18@sha256:${"b".repeat(64)} --cache-dir /cache`,
    );
    expect(scans[1]).not.toContain("--ignorefile");
    expect(scans[2]).toContain(
      `--image-src docker --db-repository mirror.gcr.io/aquasec/trivy-db ${DEVCONTAINER}`,
    );
    expect(printed()).toContain("1 of 3 images have a fixable critical or high vulnerability");
  });

  it("stops when the dev container doesn't build", () => {
    const printed = captureOutput();
    const { run, calls } = fakeRun(
      (line) => trivy(line) ?? (line.startsWith("docker build") ? { status: 1 } : {}),
    );
    expect(imageScan([], run, checkout(), "/cache")).toBe(1);
    expect(printed()).toContain("Couldn't build the dev container");
    expect(calls.some((line) => line.startsWith("trivy image"))).toBe(false);
  });

  it("scans only the images it's given, through Trivy's image when there's no local one", () => {
    captureOutput();
    const { run, calls } = fakeRun((line) => (line === "trivy --version" ? { status: null } : {}));
    expect(imageScan(["a/b:1"], run, "/repo", "/cache")).toBe(0);
    expect(calls.at(-1)).toStartWith(
      `docker run --rm --memory=1g -v /repo:/repo:ro -v /var/run/docker.sock:/var/run/docker.sock -v /cache:/root/.cache/trivy aquasec/trivy:${TRIVY_VERSION} image `,
    );
    expect(calls.at(-1)).toEndWith(" a/b:1");
  });

  it("fails rather than skipping when there's neither Trivy nor Docker", () => {
    const printed = captureOutput();
    expect(imageScan(["a/b:1"], fakeRun(() => ({ status: 1 })).run, "/repo")).toBe(1);
    expect(printed()).toContain("isn't installed and Docker isn't running");
  });
});
