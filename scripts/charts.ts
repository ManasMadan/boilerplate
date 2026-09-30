/**
 * Checks the Helm charts the way CI does: `bun run charts:check`.
 *
 *   1. helm lint, with values.schema.json (unknown or malformed values fail), and
 *      helm-unittest, for every chart of ours: deploy/charts/{stack,data} and the
 *      platform's (deploy/platform/{config,mail,jaeger});
 *   2. renders both application charts for every environment in deploy/environments,
 *      as Argo CD would, and validates each manifest against the Kubernetes API and the
 *      CRDs it uses (Gateway API, KEDA, CloudNativePG, Barman Cloud) with kubeconform;
 *   3. the platform: our charts rendered and validated the same way, every add-on chart
 *      at its pinned version with our values (their own schemas reject unknown keys),
 *      Argo CD's chart with deploy/argocd/argo-cd-values.yaml, and the Argo CD manifests;
 *   4. every file under deploy/environments/<env>/secrets/ and
 *      deploy/platform/secrets/<env>/ is a SOPS-encrypted Secret: nothing in plain text
 *      is ever committed there (scripts/secrets-check.ts, which the pre-commit hook runs
 *      on staged files too).
 *
 * Needs helm with the unittest plugin (`helm plugin install
 * https://github.com/helm-unittest/helm-unittest`) and either kubeconform or Docker.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fail, ok, ROOT } from "./lib";
import { recipientsFor, unsafeSecret } from "./secrets-check";

const CHARTS = join(ROOT, "deploy/charts");
const ENVIRONMENTS = join(ROOT, "deploy/environments");
const PLATFORM = join(ROOT, "deploy/platform");
const KUBERNETES_VERSION = "1.34.0";
const KUBECONFORM_IMAGE = "ghcr.io/yannh/kubeconform:v0.7.0";
const PROMETHEUS_IMAGE = "docker.io/prom/prometheus:v3.15.0";
const CRD_SCHEMAS =
  "https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json";

/** What each environment's release needs besides its values file (set by Argo CD / CI). */
const RELEASE_VALUES: Record<string, { stack: string[]; data: string[] }> = {
  local: { stack: [], data: [] },
  preview: {
    stack: [
      "--set-string",
      "image.tag=sha-0000000",
      "--set",
      "site.host=pr-1.preview.example.com",
      "--set",
      "observability.enabled=true",
    ],
    data: ["--set", "preview.namespace=pr-1"],
  },
  staging: { stack: ["--set-string", "image.tag=sha-0000000"], data: [] },
  production: { stack: ["--set-string", "image.tag=sha-0000000"], data: [] },
};

/** Our charts, with the values a cluster or environment always sets. */
const OWN_CHARTS: Record<string, string[]> = {
  "deploy/charts/stack": ["--set", "image.tag=sha-0", "--set", "site.host=a.b"],
  "deploy/charts/data": [
    "--set",
    "storage.uploads.host=files.a.b",
    "--set",
    "storage.uploads.corsOrigins[0]=https://a.b",
  ],
  "deploy/platform/config": [
    "--set",
    "domain=example.com",
    "--set",
    "tls.email=ops@example.com",
    "--set",
    "previews=true",
    "--set",
    "imagePolicy.enabled=true",
  ],
  "deploy/platform/mail": ["--set", "domain=example.com"],
  "deploy/platform/jaeger": [],
  "deploy/platform/alerts": ["--set", "domain=example.com", "--set", "email=ops@example.com"],
};

function run(command: string, args: string[], input?: string) {
  const result = spawnSync(command, args, { encoding: "utf8", input, cwd: ROOT });
  return { ok: result.status === 0, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

const hasKubeconform = run("kubeconform", ["-v"]).ok;
/**
 * Where kubeconform keeps the schemas it downloads: every environment and chart asks for
 * the same few dozen, and fetching each again for every one made a run take minutes on a
 * slow connection. CI caches the directory too (ci.yml's charts job).
 */
const SCHEMA_CACHE = join(ROOT, "node_modules/.cache/kubeconform");
mkdirSync(SCHEMA_CACHE, { recursive: true });

function kubeconform(manifests: string) {
  const args = (cache: string) => [
    "-strict",
    "-summary",
    "-cache",
    cache,
    "-kubernetes-version",
    KUBERNETES_VERSION,
    "-schema-location",
    "default",
    "-schema-location",
    CRD_SCHEMAS,
    "-",
  ];
  return hasKubeconform
    ? run("kubeconform", args(SCHEMA_CACHE), manifests)
    : run(
        "docker",
        [
          "run",
          "--rm",
          "-i",
          "--memory=256m",
          "--user",
          `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
          "-v",
          `${SCHEMA_CACHE}:/cache`,
          KUBECONFORM_IMAGE,
          ...args("/cache"),
        ],
        manifests,
      );
}

/** `promtool check rules` on a rendered PrometheusRule. */
function promtool(manifest: string) {
  const { spec } = Bun.YAML.parse(manifest) as { spec: { groups: unknown } };
  const script = "cat > /tmp/rules.yaml && promtool check rules /tmp/rules.yaml";
  return run(
    "docker",
    ["run", "--rm", "-i", "--memory=256m", "--entrypoint", "sh", PROMETHEUS_IMAGE, "-c", script],
    JSON.stringify({ groups: spec.groups }),
  );
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

/** A top-level `key: value` from a YAML file (the add-on definitions are flat). */
const fields = (file: string) =>
  Object.fromEntries(
    readFileSync(file, "utf8")
      .split("\n")
      .map((line) => /^(\w+): "?([^"#]*?)"?\s*$/.exec(line))
      .filter((match) => match !== null)
      .map((match) => [match[1], match[2]]),
  ) as Partial<Record<string, string>>;

// -------------------------------------------------------------------------- our charts

for (const [chart, values] of Object.entries(OWN_CHARTS)) {
  const path = join(ROOT, chart);
  check(`${chart}: lint`, run("helm", ["lint", "--strict", path, ...values]));
  check(`${chart}: unit tests`, run("helm", ["unittest", path]));
}

// ------------------------------------------------------------------------ environments

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

for (const chart of ["config", "mail", "jaeger", "alerts"]) {
  const result = run("helm", [
    "template",
    chart,
    join(PLATFORM, chart),
    ...(OWN_CHARTS[`deploy/platform/${chart}`] ?? []),
  ]);
  check(`platform ${chart} renders`, result);
  if (result.ok) check(`platform ${chart} is valid Kubernetes`, kubeconform(result.output));
}

// The alert rules, as Prometheus itself reads them (promtool, in Docker).
const rules = run("helm", [
  "template",
  "alerts",
  join(PLATFORM, "alerts"),
  "-s",
  "templates/rules.yaml",
  ...(OWN_CHARTS["deploy/platform/alerts"] ?? []),
]);
check("alert rules pass promtool", rules.ok ? promtool(rules.output) : rules);

const addonDirs = [join(PLATFORM, "addons"), join(PLATFORM, "addons/observability")];
for (const dir of addonDirs) {
  for (const file of readdirSync(dir)
    .filter((name) => name.endsWith(".yaml"))
    .sort()) {
    const addon = fields(join(dir, file));
    if (!addon.chart || !addon.repoURL || !addon.version || !addon.addon) continue;
    const chart = addon.repoURL.startsWith("https://")
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
        addon.namespace ?? "default",
        "-f",
        join(PLATFORM, "values", `${addon.addon}.yaml`),
      ]),
    );
  }
}

// Argo CD itself, at the version OpenTofu's bootstrap installs, with our values: the sops
// plugin's ConfigMap and the repo server's sidecar must come out of them.
const argocdVersion = /variable "argocd_version"[\s\S]*?default\s*=\s*"([^"]+)"/.exec(
  readFileSync(join(ROOT, "infra/tofu/modules/bootstrap/variables.tf"), "utf8"),
)?.[1];
if (argocdVersion) {
  const result = run("helm", [
    "template",
    "argocd",
    "argo-cd",
    "--repo",
    "https://argoproj.github.io/argo-helm",
    "--version",
    argocdVersion,
    "--namespace",
    "argocd",
    "-f",
    join(ROOT, "deploy/argocd/argo-cd-values.yaml"),
  ]);
  const wired =
    result.ok &&
    result.output.includes("name: argocd-cmp-cm") &&
    result.output.includes("sops.yaml:") &&
    result.output.includes("/var/run/argocd/argocd-cmp-server") &&
    result.output.includes("secretName: sops-age");
  check(`argo-cd ${argocdVersion} renders with the sops plugin`, {
    ok: wired,
    output: result.ok ? "the sops plugin or its sidecar is missing from the output" : result.output,
  });
} else {
  failed = true;
  fail("argocd_version not found in infra/tofu/modules/bootstrap/variables.tf");
}

const argocd = ["root.yaml", "projects.yaml", "repositories.yaml"]
  .map((file) => join("deploy/argocd", file))
  .concat(readdirSync(join(ROOT, "deploy/argocd/appsets")).map((f) => `deploy/argocd/appsets/${f}`))
  .map((file) => `---\n${readFileSync(join(ROOT, file), "utf8")}`)
  .join("\n");
check("Argo CD manifests are valid", kubeconform(argocd));

// ----------------------------------------------------------------------------- secrets

const secretDirs = [
  ...readdirSync(ENVIRONMENTS).map((env) => ({
    dir: join(ENVIRONMENTS, env, "secrets"),
    platform: false,
  })),
  ...(existsSync(join(PLATFORM, "secrets"))
    ? readdirSync(join(PLATFORM, "secrets")).map((env) => ({
        dir: join(PLATFORM, "secrets", env),
        platform: true,
      }))
    : []),
].filter(({ dir }) => existsSync(dir));
const problems: string[] = [];
const sopsConfig = readFileSync(join(ROOT, ".sops.yaml"), "utf8");
for (const { dir, platform } of secretDirs) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name).slice(ROOT.length + 1);
    const problem = entry.isFile()
      ? unsafeSecret(
          entry.name,
          readFileSync(join(dir, entry.name), "utf8"),
          platform,
          recipientsFor(path, sopsConfig),
        )
      : "not a file";
    if (problem) problems.push(`${path}: ${problem}`);
  }
}
check(`every committed secret is SOPS-encrypted (${secretDirs.length} directories)`, {
  ok: problems.length === 0,
  output: problems.join("\n"),
});

process.exit(failed ? 1 : 0);
