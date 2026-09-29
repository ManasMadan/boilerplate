/**
 * The whole stack on a local Kubernetes cluster (kind), deployed with the same charts
 * and images as every other environment:
 *
 *   bun run k8s:up      create the cluster, build and load the images, install data + stack
 *   bun run k8s:smoke   check the routes through the gateway (k8s:up runs it too)
 *   bun run k8s:down    delete the cluster (`bun run docker:clean` also removes the images)
 *
 * Then open http://boilerplate.localhost (email: `kubectl -n boilerplate port-forward
 * svc/mailpit 8025`, then http://localhost:8025).
 *
 * What differs from a cloud: no Argo CD, External Secrets, cert-manager or KEDA (the
 * Secrets are created here, once, from generated values; see
 * deploy/environments/local). Needs Docker with at least 8 GB of memory: the image
 * builds and the cluster together need it, and running out makes Docker kill other
 * containers too.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { fail, ok, ROOT } from "./lib";

const CLUSTER = "boilerplate";
const NAMESPACE = "boilerplate";
const HOST = "boilerplate.localhost";
const STACK = "boilerplate";
const DATA = "boilerplate-data";
const IMAGES = ["api", "worker", "notifications", "webhooks", "web", "ai", "migrate"];
const ROLES = ["migrator", "app_api", "app_worker", "app_notifications", "app_webhooks", "app_ai"];
const MIN_DOCKER_MEMORY_GB = 8;
const BUILDER = "boilerplate";
const BUILD_MEMORY = "4g";

/**
 * Where to install an add-on from, as the clusters install it (deploy/platform/addons),
 * so kind runs the same chart at the same version.
 */
function addon(name: string) {
  const file = `deploy/platform/addons/${name}.yaml`;
  const spec = Bun.YAML.parse(readFileSync(join(ROOT, file), "utf8")) as Partial<
    Record<"repoURL" | "chart" | "version" | "namespace", string>
  >;
  const { repoURL, chart, version, namespace } = spec;
  if (!repoURL || !chart || !version || !namespace) {
    throw new Error(`${file} needs repoURL, chart, version and namespace`);
  }
  const source = repoURL.startsWith("https://")
    ? [chart, "--repo", repoURL]
    : [`oci://${repoURL}/${chart}`];
  return [...source, "--version", version, "--namespace", namespace];
}

function run(command: string, args: string[], options: { input?: string; quiet?: boolean } = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    input: options.input,
    stdio: options.quiet || options.input ? "pipe" : "inherit",
  });
  return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function step(label: string, command: string, args: string[], input?: string) {
  const result = run(command, args, { input });
  if (!result.ok) {
    fail(label);
    if (result.stderr) console.error(result.stderr.trim());
    process.exit(1);
  }
  ok(label);
}

const kubectl = (args: string[], input?: string) =>
  run("kubectl", ["--context", `kind-${CLUSTER}`, ...args], { input, quiet: true });

function preflight() {
  const versionArgs: Record<string, string[]> = {
    docker: ["--version"],
    kind: ["version"],
    helm: ["version", "--short"],
    kubectl: ["version", "--client"],
  };
  for (const [tool, args] of Object.entries(versionArgs)) {
    if (!run(tool, args, { quiet: true }).ok) {
      fail(`${tool} isn't installed`);
      process.exit(1);
    }
  }
  const info = run("docker", ["info", "--format", "{{.MemTotal}}"], { quiet: true });
  const memoryGb = Number(info.stdout.trim()) / 1024 ** 3;
  if (!info.ok || memoryGb < MIN_DOCKER_MEMORY_GB - 0.5) {
    fail(
      `Docker has ${memoryGb.toFixed(1)} GB of memory; the cluster needs ${MIN_DOCKER_MEMORY_GB} GB. ` +
        "Raise it in Docker Desktop (Settings → Resources) and try again.",
    );
    process.exit(1);
  }
  ok(`Docker has ${memoryGb.toFixed(1)} GB of memory`);
}

const secret = (bytes = 32) => randomBytes(bytes).toString("base64url");

/** The Secrets the charts read, created once and kept across `k8s:up` runs. */
function secrets() {
  const exists = (name: string) => kubectl(["-n", NAMESPACE, "get", "secret", name]).ok;
  const manifests: object[] = [];
  const add = (name: string, data: Record<string, string>, type = "Opaque") => {
    if (!exists(name)) {
      manifests.push({
        apiVersion: "v1",
        kind: "Secret",
        metadata: { name, namespace: NAMESPACE },
        type,
        stringData: data,
      });
    }
  };
  const postgres = `${DATA}-postgres-rw.${NAMESPACE}.svc.cluster.local`;
  for (const role of ROLES) {
    const password = randomBytes(24).toString("hex");
    const url = `postgresql://${role}:${password}@${postgres}:5432/app`;
    add(
      `db-${role.replaceAll("_", "-")}`,
      { username: role, password, url, directUrl: url },
      "kubernetes.io/basic-auth",
    );
  }
  const valkeyPassword = randomBytes(24).toString("hex");
  const valkeyHost = `${DATA}-valkey.${NAMESPACE}.svc.cluster.local`;
  add("valkey", {
    host: valkeyHost,
    port: "6379",
    password: valkeyPassword,
    url: `redis://:${valkeyPassword}@${valkeyHost}:6379`,
  });
  const encryptionKeys = `k1:${randomBytes(32).toString("base64")}`;
  const unsubscribe = secret();
  const aiService = secret();
  const services: Record<string, Record<string, string>> = {
    web: {},
    api: {
      BETTER_AUTH_SECRET: secret(),
      ENCRYPTION_KEYS: encryptionKeys,
      UNSUBSCRIBE_SECRET: unsubscribe,
      AI_SERVICE_SECRET: aiService,
    },
    worker: {},
    notifications: { UNSUBSCRIBE_SECRET: unsubscribe },
    webhooks: { ENCRYPTION_KEYS: encryptionKeys },
    ai: { AI_SERVICE_SECRET: aiService },
  };
  // Generated together: shared values (encryption keys, service secret) must match.
  if (!exists(`${STACK}-api`)) {
    for (const [service, data] of Object.entries(services)) add(`${STACK}-${service}`, data);
  }
  if (manifests.length > 0) {
    const result = kubectl(
      ["apply", "-f", "-"],
      JSON.stringify({ apiVersion: "v1", kind: "List", items: manifests }),
    );
    if (!result.ok) {
      fail("secrets");
      console.error(result.stderr);
      process.exit(1);
    }
  }
  ok(`secrets (${manifests.length} created, the rest kept)`);
}

/** A request through the gateway on port 80, with the site's host name. */
function get(path: string) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined> }>(
    (resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port: 80, path, headers: { host: HOST } },
        (response) => {
          response.resume();
          resolve({ status: response.statusCode ?? 0, headers: response.headers });
        },
      );
      req.on("error", reject);
      req.setTimeout(10_000, () => req.destroy(new Error("timed out")));
      req.end();
    },
  );
}

async function smoke() {
  const checks: [string, string, (r: Awaited<ReturnType<typeof get>>) => boolean][] = [
    ["web", "/healthz", (r) => r.status === 200],
    ["web page", "/sign-in", (r) => r.status === 200],
    ["api", "/api/v1/system", (r) => r.status === 200],
    ["api auth", "/api/auth/ok", (r) => r.status === 200],
    ["OAuth metadata", "/.well-known/oauth-authorization-server/api/auth", (r) => r.status === 200],
    [
      "AI MCP server",
      "/ai/mcp",
      (r) =>
        r.status === 401 && String(r.headers["www-authenticate"]).includes("resource_metadata"),
    ],
    [
      "webhooks",
      "/webhooks/stripe",
      (r) => r.status === 404 || r.status === 405 || r.status === 400,
    ],
  ];
  let passed = true;
  for (const [label, path, expect] of checks) {
    const result = await get(path).catch((error: Error) => ({ status: 0, headers: {}, error }));
    if (expect(result)) {
      ok(`${label}: ${path} → ${result.status}`);
    } else {
      passed = false;
      fail(`${label}: ${path} → ${result.status}`);
    }
  }
  if (!passed) process.exit(1);
}

async function up() {
  preflight();
  if (!run("kind", ["get", "clusters"], { quiet: true }).stdout.split("\n").includes(CLUSTER)) {
    step("cluster", "kind", ["create", "cluster", "--config", "deploy/local/kind.yaml"]);
  } else {
    ok("cluster (exists)");
  }
  step("Envoy Gateway", "helm", [
    "upgrade",
    "--install",
    "eg",
    ...addon("envoy-gateway"),
    "--create-namespace",
    "--kube-context",
    `kind-${CLUSTER}`,
    "--wait",
  ]);
  step("CloudNativePG", "helm", [
    "upgrade",
    "--install",
    "cnpg",
    ...addon("cloudnative-pg"),
    "--create-namespace",
    "--kube-context",
    `kind-${CLUSTER}`,
    "--wait",
  ]);
  kubectl(["create", "namespace", "gateway-system"]);
  kubectl(["create", "namespace", NAMESPACE]);
  step("gateway", "kubectl", [
    "--context",
    `kind-${CLUSTER}`,
    "apply",
    "-f",
    "deploy/local/gateway.yaml",
  ]);
  step("mailpit", "kubectl", [
    "--context",
    `kind-${CLUSTER}`,
    "apply",
    "-f",
    "deploy/local/mailpit.yaml",
  ]);

  // A builder of our own: its memory is capped (a build can't starve other containers)
  // and its cache goes away with `bun run docker:clean`. One image at a time.
  if (!run("docker", ["buildx", "inspect", BUILDER], { quiet: true }).ok) {
    step("image builder", "docker", [
      "buildx",
      "create",
      "--name",
      BUILDER,
      "--driver",
      "docker-container",
      "--driver-opt",
      `memory=${BUILD_MEMORY}`,
      "--driver-opt",
      "default-load=true",
    ]);
  }
  for (const image of IMAGES) {
    step(`image ${image}`, "docker", [
      "buildx",
      "bake",
      image,
      "--builder",
      BUILDER,
      "--load",
      "--set",
      "*.args.RELEASE=dev",
    ]);
  }
  step("images loaded into the cluster", "kind", [
    "load",
    "docker-image",
    "--name",
    CLUSTER,
    ...IMAGES.map((image) => `boilerplate/${image}:dev`),
  ]);

  secrets();
  step("data (Postgres, Valkey)", "helm", [
    "upgrade",
    "--install",
    DATA,
    join(ROOT, "deploy/charts/data"),
    "-f",
    join(ROOT, "deploy/environments/local/data.yaml"),
    "--namespace",
    NAMESPACE,
    "--kube-context",
    `kind-${CLUSTER}`,
    "--wait",
    "--timeout",
    "10m",
  ]);
  step("Postgres ready", "kubectl", [
    "--context",
    `kind-${CLUSTER}`,
    "-n",
    NAMESPACE,
    "wait",
    `cluster/${DATA}-postgres`,
    "--for=condition=Ready",
    "--timeout=10m",
  ]);
  step("stack (migrations, then every service)", "helm", [
    "upgrade",
    "--install",
    STACK,
    join(ROOT, "deploy/charts/stack"),
    "-f",
    join(ROOT, "deploy/environments/local/stack.yaml"),
    "--namespace",
    NAMESPACE,
    "--kube-context",
    `kind-${CLUSTER}`,
    "--wait",
    "--timeout",
    "15m",
  ]);
  await smoke();
  console.log(`\n  http://${HOST}`);
}

const command = process.argv[2];
if (command === "up") await up();
else if (command === "smoke") await smoke();
else if (command === "down")
  step("cluster deleted", "kind", ["delete", "cluster", "--name", CLUSTER]);
else {
  console.error("usage: bun scripts/k8s.ts up | smoke | down");
  process.exit(1);
}
