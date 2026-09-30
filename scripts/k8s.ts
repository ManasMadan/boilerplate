/**
 * The whole stack on a local Kubernetes cluster (kind), deployed with the same charts
 * and images as every other environment:
 *
 *   bun run k8s:up      create the cluster, build and load the images, install data + stack
 *   bun run k8s:smoke   check the routes through the gateway, then run re-encryption as
 *                       operators do after a key rotation (k8s:up runs it too)
 *   bun run k8s:down    delete the cluster (`bun run docker:clean` also removes the images)
 *
 * Then open http://localhost (email: `kubectl -n boilerplate port-forward
 * svc/mailpit 8025`, then http://localhost:8025).
 *
 * What differs from a cluster: no Argo CD, cert-manager, KEDA or mail server. The data
 * chart generates its own credentials as everywhere; the services' Secrets, which
 * clusters decrypt from SOPS files, are created here once from generated values, in
 * plain text straight into the cluster (never on disk). Email goes to Mailpit over TLS
 * with a certificate authority made here too, since production settings refuse
 * anything else. Needs Docker with at least 8 GB of memory: the image builds and the
 * cluster together need it, and running out makes Docker kill other containers too.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fail, ok, ROOT } from "./lib";

const CLUSTER = "boilerplate";
const NAMESPACE = "boilerplate";
const HOST = "localhost";
/** The address the stack sends email from, and signs in to Mailpit as. */
const MAIL_DOMAIN = "boilerplate.localhost";
/** The uploads bucket's public host (deploy/environments/local/data.yaml). */
const FILES_HOST = "files.localhost";
const STACK = "boilerplate";
const DATA = "boilerplate-data";
const IMAGES = ["api", "worker", "notifications", "webhooks", "web", "ai", "migrate"];
const MIN_DOCKER_MEMORY_GB = 8;
const BUILDER = "boilerplate";
// CI's runners have room to build every image at once while the cluster comes up; a
// laptop builds one at a time after it, in a builder whose memory is capped.
const IN_CI = process.env.CI === "true";
const BUILD_MEMORY = IN_CI ? "8g" : "4g";

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

/**
 * step(), without blocking: steps that don't depend on each other run side by side. The
 * output goes to a file, not a pipe, so a long build never stalls while a blocking step
 * runs; it's shown when the step fails.
 */
async function stepAsync(label: string, command: string, args: string[]) {
  const log = join(tmpdir(), `k8s-${label.replace(/\W+/g, "-")}-${process.pid}.log`);
  const fd = openSync(log, "w");
  const child = Bun.spawn([command, ...args], { cwd: ROOT, stdout: fd, stderr: fd });
  const code = await child.exited;
  closeSync(fd);
  if (code !== 0) {
    fail(label);
    console.error(readFileSync(log, "utf8").trim().split("\n").slice(-80).join("\n"));
    process.exit(1);
  }
  rmSync(log, { force: true });
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
    openssl: ["version"],
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

/**
 * Mailpit's certificate, from a certificate authority of this cluster's own: the
 * notifications service trusts it (`caBundle` in deploy/environments/local/stack.yaml)
 * and checks the certificate, as production requires. Made once; the CA's key is thrown
 * away, so nothing else can be signed with it.
 */
function mailpitCertificate() {
  if (kubectl(["-n", NAMESPACE, "get", "secret", "mailpit-tls"]).ok) {
    ok("Mailpit's certificate (exists)");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "boilerplate-kind-"));
  const at = (file: string) => join(dir, file);
  const openssl = (command: string) => {
    const result = spawnSync("openssl", command.split(" "), { cwd: dir, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
  };
  let problem = "";
  try {
    writeFileSync(at("ext"), "subjectAltName=DNS:mailpit\nextendedKeyUsage=serverAuth\n");
    openssl(
      "req -x509 -newkey rsa:2048 -nodes -days 3650 -subj /CN=boilerplate-kind-ca " +
        "-addext basicConstraints=critical,CA:TRUE -addext keyUsage=critical,keyCertSign,cRLSign " +
        "-keyout ca.key -out ca.crt",
    );
    openssl("req -newkey rsa:2048 -nodes -subj /CN=mailpit -keyout tls.key -out tls.csr");
    openssl(
      "x509 -req -in tls.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 3650 " +
        "-extfile ext -out tls.crt",
    );
    const manifest = (name: string, stringData: Record<string, string>, type = "Opaque") => ({
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name, namespace: NAMESPACE },
      type,
      stringData,
    });
    const read = (file: string) => readFileSync(at(file), "utf8");
    const items = [
      manifest("local-ca", { "ca.crt": read("ca.crt") }),
      manifest(
        "mailpit-tls",
        { "tls.crt": read("tls.crt"), "tls.key": read("tls.key") },
        "kubernetes.io/tls",
      ),
    ];
    const result = kubectl(
      ["apply", "-f", "-"],
      JSON.stringify({ apiVersion: "v1", kind: "List", items }),
    );
    if (!result.ok) problem = result.stderr;
  } catch (error) {
    problem = (error as Error).message;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (problem) {
    fail("Mailpit's certificate");
    console.error(problem);
    process.exit(1);
  }
  ok("Mailpit's certificate");
}

const secret = (bytes = 32) => randomBytes(bytes).toString("base64url");

/**
 * The services' Secrets (`<release>-<service>`), created once and kept across `k8s:up`
 * runs. Clusters decrypt theirs from deploy/environments/<env>/secrets/; these are
 * generated, and never leave the cluster. The data chart makes the database, Valkey and
 * storage credentials itself.
 */
function secrets() {
  if (kubectl(["-n", NAMESPACE, "get", "secret", `${STACK}-api`]).ok) {
    ok("secrets (exist)");
    return;
  }
  const encryptionKeys = `k1:${randomBytes(32).toString("base64")}`;
  const unsubscribe = secret();
  const aiService = secret();
  // Mailpit takes any login; production settings still want one.
  const smtpUrl = `smtps://no-reply%40${MAIL_DOMAIN}:${secret(16)}@mailpit:1025`;
  // Generated together: shared values (encryption keys, service secret) must match.
  const services: Record<string, Record<string, string>> = {
    api: {
      BETTER_AUTH_SECRET: secret(),
      ENCRYPTION_KEYS: encryptionKeys,
      UNSUBSCRIBE_SECRET: unsubscribe,
      AI_SERVICE_SECRET: aiService,
    },
    notifications: { UNSUBSCRIBE_SECRET: unsubscribe, SMTP_URL: smtpUrl },
    webhooks: { ENCRYPTION_KEYS: encryptionKeys },
    ai: { AI_SERVICE_SECRET: aiService },
  };
  const items = Object.entries(services).map(([service, stringData]) => ({
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: `${STACK}-${service}`, namespace: NAMESPACE },
    type: "Opaque",
    stringData,
  }));
  const result = kubectl(
    ["apply", "-f", "-"],
    JSON.stringify({ apiVersion: "v1", kind: "List", items }),
  );
  if (!result.ok) {
    fail("secrets");
    console.error(result.stderr);
    process.exit(1);
  }
  ok(`secrets (${items.length} created)`);
}

/** A request through the gateway on port 80, with the site's host name (or another). */
function get(path: string, host = HOST) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined> }>(
    (resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: 80, path, headers: { host } }, (response) => {
        response.resume();
        resolve({ status: response.statusCode ?? 0, headers: response.headers });
      });
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
  // The uploads bucket's public host reaches RustFS, which answers its health check.
  const files = await get("/health", FILES_HOST).catch(() => ({ status: 0 }));
  if (files.status === 200) {
    ok(`files: ${FILES_HOST}/health → ${files.status}`);
  } else {
    passed = false;
    fail(`files: ${FILES_HOST}/health → ${files.status}`);
  }
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
  await reencrypt();
}

/**
 * Re-encryption runs in the cluster the way an operator runs it after a key rotation
 * (the rotate-secrets skill): a Job created from the stack's suspended CronJob.
 */
async function reencrypt() {
  const job = `reencrypt-${Date.now()}`;
  const created = kubectl([
    "-n",
    NAMESPACE,
    "create",
    "job",
    job,
    `--from=cronjob/${STACK}-reencrypt`,
  ]);
  if (!created.ok) {
    fail(`re-encryption: ${created.stderr.trim()}`);
    process.exit(1);
  }
  const deadline = Date.now() + 5 * 60_000;
  let status = "";
  while (Date.now() < deadline) {
    status = kubectl([
      "-n",
      NAMESPACE,
      "get",
      "job",
      job,
      "-o",
      "jsonpath={.status.succeeded},{.status.failed}",
    ]).stdout;
    if (status.startsWith("1") || status.endsWith(",1")) break;
    await Bun.sleep(2000);
  }
  const logs = kubectl(["-n", NAMESPACE, "logs", `job/${job}`]).stdout.trim();
  if (status.startsWith("1")) {
    ok(
      `re-encryption: ${logs.split("\n").find((line) => line.startsWith("Re-encrypted")) ?? "done"}`,
    );
  } else {
    fail(`re-encryption: job ${job} ${status.endsWith(",1") ? "failed" : "timed out"}`);
    console.error(logs);
    process.exit(1);
  }
}

/**
 * Every image, as boilerplate/<image>:dev, in a builder of our own: its memory is capped
 * (a build can't starve other containers) and its cache goes away with
 * `bun run docker:clean`. In CI all at once, reading the layers deploy.yml caches on
 * master when GitHub's cache is reachable, each loaded into the cluster as soon as it's
 * built and the cluster exists; locally one image at a time, loaded together after.
 */
async function buildImages(cluster: Promise<void>) {
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
  const bake = (targets: string[]) => [
    "buildx",
    "bake",
    ...targets,
    "--builder",
    BUILDER,
    "--load",
    "--set",
    "*.args.RELEASE=dev",
    ...(IN_CI && process.env.ACTIONS_CACHE_URL
      ? ["--set", "*.cache-from=type=gha,scope=amd64"]
      : []),
  ];
  const load = (images: string[]) =>
    stepAsync(`${images.join(", ")} loaded into the cluster`, "kind", [
      "load",
      "docker-image",
      "--name",
      CLUSTER,
      ...images.map((image) => `boilerplate/${image}:dev`),
    ]);
  if (IN_CI) {
    // Concurrent builds share the builder's cache, so common layers still build once.
    await Promise.all(
      IMAGES.map(async (image) => {
        await stepAsync(`image ${image}`, "docker", bake([image]));
        await cluster;
        await load([image]);
      }),
    );
    return;
  }
  for (const image of IMAGES) await stepAsync(`image ${image}`, "docker", bake([image]));
  await cluster;
  await load(IMAGES);
}

async function up() {
  preflight();
  const exists = run("kind", ["get", "clusters"], { quiet: true }).stdout.split("\n");
  const cluster = exists.includes(CLUSTER)
    ? Promise.resolve(ok("cluster (exists)"))
    : stepAsync("cluster", "kind", ["create", "cluster", "--config", "deploy/local/kind.yaml"]);
  // Only our charts need our images: in CI they build while the cluster gets ready.
  const images = IN_CI ? buildImages(cluster) : undefined;
  await cluster;
  const envoy = stepAsync("Envoy Gateway", "helm", [
    "upgrade",
    "--install",
    "eg",
    ...addon("envoy-gateway"),
    "--create-namespace",
    "--kube-context",
    `kind-${CLUSTER}`,
    "--wait",
  ]);
  const cnpg = stepAsync("CloudNativePG", "helm", [
    "upgrade",
    "--install",
    "cnpg",
    ...addon("cloudnative-pg"),
    "--create-namespace",
    "--kube-context",
    `kind-${CLUSTER}`,
    "--wait",
  ]);
  await Promise.all([envoy, cnpg]);
  kubectl(["create", "namespace", "gateway-system"]);
  kubectl(["create", "namespace", NAMESPACE]);
  mailpitCertificate();
  secrets();
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

  const data = () =>
    stepAsync("data (Postgres, Valkey, RustFS; credentials generated)", "helm", [
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
  if (images === undefined) {
    await buildImages(cluster);
    await data();
  } else {
    await Promise.all([images, data()]);
  }
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
