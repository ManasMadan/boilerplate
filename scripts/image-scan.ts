/**
 * Known vulnerabilities in the third-party images we run: `bun scripts/image-scan.ts`,
 * the Security workflow's "Third-party images" job, or `bun scripts/image-scan.ts <ref>…`
 * for some of them. Every image the charts' values, the local and Argo CD manifests,
 * compose and the dev container name (each pinned by digest, scripts/dockerfiles.test.ts)
 * goes through Trivy's image scan as CI's Container images jobs scan ours: a fixable
 * critical or high vulnerability fails, unless .trivyignore.yaml records why it doesn't
 * reach us, with an expiry. The images are read straight from their registries, one at a
 * time, never pulled into Docker. A local trivy of CI's version, else its image in
 * Docker; with neither, it fails and says how to get one.
 */
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fail, ok, ROOT, runMain, runSync } from "./lib";
import { TRIVY_VERSION } from "./misconfig";

/** An image reference in a manifest, values file or compose file, with its tag. */
const IMAGE = /^\s*(?:-\s+)?(?:image|imageName|imageRef):\s*["']?([^\s"'{]+:[^\s"']+)["']?\s*$/gm;

/** The files that name images: deploy/'s YAML (not tests or renders) and compose's. */
export function imageFiles(root = ROOT) {
  return [
    ...readdirSync(join(root, "deploy"), { recursive: true, encoding: "utf8" })
      .filter((path) => /\.ya?ml$/.test(path) && !/(^|\/)(\.rendered|tests)\//.test(path))
      .map((path) => join("deploy", path)),
    ...readdirSync(root).filter((file) => /^docker-compose.*\.ya?ml$/.test(file)),
  ];
}

/** Every image reference in `files` (under `root`), as `file: reference`. */
export const imageReferences = (root = ROOT, files = imageFiles(root)) =>
  files.flatMap((file) =>
    [...readFileSync(join(root, file), "utf8").matchAll(IMAGE)].map((m) => `${file}: ${m[1]}`),
  );

/**
 * The third-party images, each once: the references above and the dev container's base
 * images, without our own (built locally as :dev, or in CI, which scans them).
 */
export function thirdPartyImages(root = ROOT) {
  const devcontainer = readFileSync(join(root, ".devcontainer/Dockerfile"), "utf8");
  const refs = [
    ...imageReferences(root).map((line) => line.slice(line.indexOf(": ") + 2)),
    ...[...devcontainer.matchAll(/^FROM (\S+)/gm)].map((m) => m[1] ?? ""),
  ];
  const images = refs
    .filter((ref) => !ref.endsWith(":dev"))
    .map((ref) => ref.replace(/^docker\.io\//, ""));
  return [...new Set(images)].sort();
}

/** Scans `images` (every third-party image by default); the exit code. */
export function imageScan(
  images = process.argv.slice(2),
  run = runSync,
  root = ROOT,
  cache = join(homedir(), ".cache/boilerplate/trivy"),
): number {
  const chosen = images.length > 0 ? images : thirdPartyImages(root);
  const scan = (ref: string) => [
    "image",
    "--quiet",
    // Vulnerabilities only: a third-party image's own files (Debian's snake-oil TLS key
    // in Postgres's, say) aren't secrets of ours.
    "--scanners",
    "vuln",
    "--exit-code",
    "1",
    "--ignore-unfixed",
    "--severity",
    "CRITICAL,HIGH",
    "--ignorefile",
    join(root, ".trivyignore.yaml"),
    "--image-src",
    "remote",
    // A mirror of Trivy's vulnerability database without GHCR's rate limit (as CI's).
    "--db-repository",
    "mirror.gcr.io/aquasec/trivy-db",
    ref,
  ];
  let trivy: (ref: string) => [string, string[]];
  if (run("trivy", ["--version"], { cwd: root }).stdout.includes(`Version: ${TRIVY_VERSION}\n`)) {
    trivy = (ref) => ["trivy", [...scan(ref), "--cache-dir", cache]];
  } else if (run("docker", ["info"], { cwd: root, stdio: "ignore" }).status === 0) {
    const image = ["run", "--rm", "--memory=1g", "-v", `${root}:${root}:ro`];
    const cached = ["-v", `${cache}:/root/.cache/trivy`, `aquasec/trivy:${TRIVY_VERSION}`];
    trivy = (ref) => ["docker", [...image, ...cached, ...scan(ref)]];
  } else {
    fail(
      `Trivy ${TRIVY_VERSION} isn't installed and Docker isn't running: install that version (https://github.com/aquasecurity/trivy/releases) or start Docker`,
    );
    return 1;
  }
  const failed: string[] = [];
  for (const ref of chosen) {
    const [command, args] = trivy(ref);
    if (run(command, args, { cwd: root, stdio: "inherit" }).status === 0) {
      ok(ref);
    } else {
      failed.push(ref);
      fail(ref);
    }
  }
  if (failed.length > 0) {
    fail(
      `${failed.length} of ${chosen.length} images have a fixable critical or high vulnerability`,
    );
    return 1;
  }
  return 0;
}

await runMain(import.meta, imageScan);
