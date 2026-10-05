/**
 * Known vulnerabilities in the third-party images we run: `bun scripts/image-scan.ts`,
 * the Security workflow's "Third-party images" job, or `bun scripts/image-scan.ts <ref>…`
 * for some of them. Every image the charts' values, the local and Argo CD manifests and
 * compose name (each pinned by digest, scripts/dockerfiles.test.ts), and the dev
 * container as it builds, goes through Trivy's image scan as CI's Container images jobs
 * scan ours: a fixable critical or high vulnerability fails.
 *
 * The images are read straight from their registries, one at a time, never pulled into
 * Docker; the dev container is built (Docker's cache keeps that quick after the first
 * time) since its Dockerfile updates what its base ships. A vulnerability with no fixed
 * image upstream yet is a reviewed exception in that image's own file under
 * .trivyignores/ (<repository>.yaml), each entry with its reason and an expiry: once it
 * passes, the scan fails again, so someone looks for the rebuilt image.
 *
 * Trivy: a local one of CI's version, else its image in Docker; with neither, it fails
 * and says how to get one.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fail, ok, ROOT, type Run, runMain, runSync } from "./lib";
import { TRIVY_VERSION } from "./misconfig";

/** An image reference in a manifest, values file or compose file, with its tag. */
const IMAGE = /^\s*(?:-\s+)?(?:image|imageName|imageRef):\s*["']?([^\s"'{]+:[^\s"']+)["']?\s*$/gm;

/** What the dev container builds as, to be scanned. */
export const DEVCONTAINER = "boilerplate/devcontainer:dev";

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

/** The third-party images, each once, without our own (built locally as :dev, or in CI). */
export function thirdPartyImages(root = ROOT) {
  const images = imageReferences(root)
    .map((line) => line.slice(line.indexOf(": ") + 2))
    .filter((ref) => !ref.endsWith(":dev"))
    .map((ref) => ref.replace(/^docker\.io\//, ""));
  return [...new Set(images)].sort();
}

/** An image's reviewed exceptions: .trivyignores/<repository, without tag or digest>.yaml. */
export function ignoreFile(root: string, ref: string) {
  const repository = ref
    .replace(/^docker\.io\//, "")
    .replace(/@.*$/, "")
    .replace(/:[^/:]*$/, "");
  return join(root, ".trivyignores", `${repository}.yaml`);
}

type Trivy = (args: string[]) => [string, string[]];

/** How Trivy runs here, or undefined with neither a local one of CI's version nor Docker. */
function trivyWith(run: Run, root: string, cache: string): Trivy | undefined {
  if (run("trivy", ["--version"], { cwd: root }).stdout.includes(`Version: ${TRIVY_VERSION}\n`)) {
    return (args) => ["trivy", [...args, "--cache-dir", cache]];
  }
  if (run("docker", ["info"], { cwd: root, stdio: "ignore" }).status === 0) {
    // The Docker socket: the dev container is scanned from Docker's images.
    const image = ["run", "--rm", "--memory=1g", "-v", `${root}:${root}:ro`];
    const socket = ["-v", "/var/run/docker.sock:/var/run/docker.sock"];
    const cached = ["-v", `${cache}:/root/.cache/trivy`, `aquasec/trivy:${TRIVY_VERSION}`];
    return (args) => ["docker", [...image, ...socket, ...cached, ...args]];
  }
  return undefined;
}

/** Trivy's arguments for scanning `ref` from `source` (registry or docker). */
function scanArgs(root: string, ref: string, source: "remote" | "docker") {
  const ignores = ignoreFile(root, ref);
  return [
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
    ...(existsSync(ignores) ? ["--ignorefile", ignores] : []),
    "--image-src",
    source,
    // A mirror of Trivy's vulnerability database without GHCR's rate limit (as CI's).
    "--db-repository",
    "mirror.gcr.io/aquasec/trivy-db",
    ref,
  ];
}

/**
 * Scans `images` (every third-party image, and the dev container, by default); the exit
 * code.
 */
export function imageScan(
  images = process.argv.slice(2),
  run = runSync,
  root = ROOT,
  cache = join(homedir(), ".cache/boilerplate/trivy"),
): number {
  const trivy = trivyWith(run, root, cache);
  if (!trivy) {
    fail(
      `Trivy ${TRIVY_VERSION} isn't installed and Docker isn't running: install that version (https://github.com/aquasecurity/trivy/releases) or start Docker`,
    );
    return 1;
  }
  const scans: { ref: string; source: "remote" | "docker" }[] = (
    images.length > 0 ? images : thirdPartyImages(root)
  ).map((ref) => ({ ref, source: "remote" }));
  if (images.length === 0) {
    const built = run("docker", ["build", "--quiet", "-t", DEVCONTAINER, ".devcontainer"], {
      cwd: root,
      stdio: ["ignore", "ignore", "inherit"],
    });
    if (built.status !== 0) {
      fail("Couldn't build the dev container (Docker's output is above), so it isn't scanned");
      return 1;
    }
    scans.push({ ref: DEVCONTAINER, source: "docker" });
  }
  const failed: string[] = [];
  for (const { ref, source } of scans) {
    const [command, args] = trivy(scanArgs(root, ref, source));
    if (run(command, args, { cwd: root, stdio: "inherit" }).status === 0) {
      ok(ref);
    } else {
      failed.push(ref);
      fail(ref);
    }
  }
  if (failed.length > 0) {
    fail(
      `${failed.length} of ${scans.length} images have a fixable critical or high vulnerability`,
    );
    return 1;
  }
  return 0;
}

await runMain(import.meta, imageScan);
