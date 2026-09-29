/**
 * Checks the Helm charts the way CI does: `bun run charts:check`.
 *
 *   1. helm lint, with values.schema.json (unknown or malformed values fail);
 *   2. helm-unittest (deploy/charts/<chart>/tests);
 *   3. renders both charts for every environment in deploy/environments, as Argo CD
 *      would, and validates each manifest against the Kubernetes API and the CRDs it
 *      uses (Gateway API, KEDA, External Secrets, CloudNativePG) with kubeconform;
 *   4. the platform: deploy/platform/config for each cloud, every add-on chart at its
 *      pinned version with our values (their own schemas reject unknown keys), and the
 *      Argo CD manifests in deploy/argocd.
 *
 * Needs helm with the unittest plugin (`helm plugin install
 * https://github.com/helm-unittest/helm-unittest`) and either kubeconform or Docker.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fail, ok, ROOT } from "./lib";

const CHARTS = join(ROOT, "deploy/charts");
const ENVIRONMENTS = join(ROOT, "deploy/environments");
const KUBERNETES_VERSION = "1.34.0";
const KUBECONFORM_IMAGE = "ghcr.io/yannh/kubeconform:v0.7.0";
const CRD_SCHEMAS =
  "https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json";

/** What each environment's release needs besides its values file (set by Argo CD / CI). */
const RELEASE_VALUES: Record<string, { stack: string[]; data: string[] }> = {
  local: { stack: [], data: [] },
  preview: {
    stack: ["--set-string", "image.tag=sha-0000000", "--set", "site.host=pr-1.preview.example.com"],
    data: ["--set", "preview.namespace=pr-1"],
  },
  staging: { stack: ["--set-string", "image.tag=sha-0000000"], data: [] },
  production: { stack: ["--set-string", "image.tag=sha-0000000"], data: [] },
};

function run(command: string, args: string[], input?: string) {
  const result = spawnSync(command, args, { encoding: "utf8", input, cwd: ROOT });
  return { ok: result.status === 0, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

const hasKubeconform = run("kubeconform", ["-v"]).ok;
function kubeconform(manifests: string) {
  const args = [
    "-strict",
    "-summary",
    "-kubernetes-version",
    KUBERNETES_VERSION,
    "-schema-location",
    "default",
    "-schema-location",
    CRD_SCHEMAS,
    "-",
  ];
  return hasKubeconform
    ? run("kubeconform", args, manifests)
    : run("docker", ["run", "--rm", "-i", "--memory=256m", KUBECONFORM_IMAGE, ...args], manifests);
}

let failed = false;
const check = (label: string, result: { ok: boolean; output: string }) => {
  if (result.ok) {
    ok(label);
  } else {
    failed = true;
    fail(label);
    console.error(result.output.trim());
  }
};

for (const chart of ["stack", "data"] as const) {
  const path = join(CHARTS, chart);
  const lintValues =
    chart === "stack" ? ["--set", "image.tag=sha-0", "--set", "site.host=a.b"] : [];
  check(`${chart}: lint`, run("helm", ["lint", "--strict", path, ...lintValues]));
  check(`${chart}: unit tests`, run("helm", ["unittest", path]));
}

for (const env of readdirSync(ENVIRONMENTS).sort()) {
  const extra = RELEASE_VALUES[env];
  if (!extra) {
    failed = true;
    fail(`${env}: add it to RELEASE_VALUES in scripts/charts.ts`);
    continue;
  }
  const rendered: string[] = [];
  for (const chart of ["data", "stack"] as const) {
    const result = run("helm", [
      "template",
      env,
      join(CHARTS, chart),
      "--namespace",
      env,
      "-f",
      join(ENVIRONMENTS, env, `${chart}.yaml`),
      ...extra[chart],
    ]);
    check(`${env}: ${chart} renders`, result);
    if (result.ok) rendered.push(result.output);
  }
  if (rendered.length === 2) {
    check(`${env}: manifests are valid Kubernetes`, kubeconform(rendered.join("\n---\n")));
  }
}

// ---------------------------------------------------------------------------- platform

const PLATFORM = join(ROOT, "deploy/platform");
const CLUSTERS: Record<string, string[]> = {
  aws: ["--set", "secretStore.provider=aws", "--set", "secretStore.aws.region=eu-west-1"],
  gcp: ["--set", "secretStore.gcp.projectID=example"],
  azure: ["--set", "secretStore.azure.vaultUrl=https://example.vault.azure.net"],
  other: ["--set", "secretStore.provider=vault", "--set", "secretStore.vault.server=https://vault"],
};
for (const [cloud, values] of Object.entries(CLUSTERS)) {
  const result = run("helm", [
    "template",
    "platform-config",
    join(PLATFORM, "config"),
    "-f",
    join(PLATFORM, "config", `values-${cloud}.yaml`),
    "--set",
    `cloud=${cloud}`,
    "--set",
    "domain=example.com",
    "--set",
    "tls.email=ops@example.com",
    "--set",
    "previews=true",
    "--set",
    "secretPrefix=boilerplate-staging-",
    "--set",
    "imagePolicy.enabled=true",
    ...values,
  ]);
  check(`platform-config (${cloud}) renders`, result);
  if (result.ok) check(`platform-config (${cloud}) is valid`, kubeconform(result.output));
}

for (const file of readdirSync(join(PLATFORM, "addons")).sort()) {
  const addon = Object.fromEntries(
    readFileSync(join(PLATFORM, "addons", file), "utf8")
      .split("\n")
      .map((line) => /^(\w+): "?([^"#]*?)"?\s*$/.exec(line))
      .filter((match) => match !== null)
      .map((match) => [match[1], match[2]]),
  );
  if (!addon.chart) continue;
  const chart = addon.repoURL?.startsWith("https://")
    ? [addon.chart, "--repo", addon.repoURL]
    : [`oci://${addon.repoURL}/${addon.chart}`];
  check(
    `${addon.addon} ${addon.version} renders with our values`,
    run("helm", [
      "template",
      addon.addon,
      ...chart,
      "--version",
      addon.version,
      "--namespace",
      addon.namespace,
      "-f",
      join(PLATFORM, "values", `${addon.addon}.yaml`),
    ]),
  );
}

const argocd = ["root.yaml", "projects.yaml", "repositories.yaml"]
  .map((file) => join("deploy/argocd", file))
  .concat(readdirSync(join(ROOT, "deploy/argocd/appsets")).map((f) => `deploy/argocd/appsets/${f}`))
  .map((file) => `---\n${readFileSync(join(ROOT, file), "utf8")}`)
  .join("\n");
check("Argo CD manifests are valid", kubeconform(argocd));

process.exit(failed ? 1 : 0);
