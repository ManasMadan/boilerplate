/**
 * Runs the end-to-end suite against a stack it builds and starts itself, then stops it.
 * CI and local runs use this same script, so both test exactly what was just built.
 *
 *   bun run test:e2e                       the whole suite
 *   bun run test:e2e e2e/assistant.spec.ts  arguments go to Playwright
 *
 * It refuses to start while anything already listens on the stack's ports: an older
 * server would answer instead and the run would test stale code. To iterate against a
 * stack you are already running (`bun dev`), use `bun run --cwd apps/web test:e2e`.
 *
 * Postgres, Valkey, Mailpit, RustFS and ClamAV come from `docker compose --profile full`
 * (CI starts its own); the services run as NODE_ENV=test, since production refuses the
 * local stand-ins the suite relies on. What runs is still the production build.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdirSync, openSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fail, ok, ROOT } from "./lib";

const SERVICES = [
  {
    name: "fake-stripe",
    cwd: "packages/fake-stripe",
    run: ["start"],
    ready: "http://127.0.0.1:12111/__fake/state",
  },
  { name: "api", cwd: "apps/api", run: ["start"], ready: "http://localhost:3001/health/ready" },
  {
    name: "worker",
    cwd: "apps/worker",
    run: ["start"],
    ready: "http://localhost:3002/health/ready",
  },
  {
    name: "notifications",
    cwd: "apps/notifications",
    run: ["start"],
    ready: "http://localhost:3003/health/ready",
  },
  {
    name: "webhooks",
    cwd: "apps/webhooks",
    run: ["start"],
    ready: "http://localhost:3004/health/ready",
  },
  { name: "ai", cwd: "apps/ai", run: ["start"], ready: "http://localhost:8000/health/ready" },
  { name: "ai-worker", cwd: "apps/ai", run: ["worker"], ready: undefined },
  { name: "web", cwd: "apps/web", run: ["start"], ready: "http://localhost:3000/healthz" },
] as const;

const BUILT = ["@repo/api", "@repo/worker", "@repo/notifications", "@repo/webhooks", "@repo/web"];
const READY_TIMEOUT_MS = 90_000;
const LOGS = join(ROOT, "logs");

function listening(url: string) {
  const { hostname, port } = new URL(url);
  return new Promise<boolean>((resolve) => {
    const socket = connect({ host: hostname, port: Number(port) });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

async function ready(url: string, child: ChildProcess) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return false;
    const response = await fetch(url).catch(() => undefined);
    if (response?.ok) return true;
    await sleep(500);
  }
  return false;
}

const busy = (
  await Promise.all(
    SERVICES.map(async (s) => (s.ready && (await listening(s.ready)) ? s : undefined)),
  )
).filter((s) => s !== undefined);
if (busy.length > 0) {
  for (const s of busy) fail(`${s.name}: something already listens on ${new URL(s.ready).host}`);
  console.error(
    "Stop the running stack first, or test against it with `bun run --cwd apps/web test:e2e`.",
  );
  process.exit(1);
}

const build = spawnSync("bunx", ["turbo", "run", "build", ...BUILT.map((p) => `--filter=${p}`)], {
  cwd: ROOT,
  stdio: "inherit",
  env: { ...process.env, NODE_ENV: "production" },
});
if (build.status !== 0) process.exit(build.status ?? 1);

mkdirSync(LOGS, { recursive: true });
const running: { name: string; process: ChildProcess }[] = [];

function stopAll() {
  for (const { process: child } of running) {
    // Each service runs in its own process group (bun → uv → python, for example).
    if (child.pid && child.exitCode === null) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    }
  }
}
process.on("SIGINT", () => {
  stopAll();
  process.exit(130);
});
process.on("SIGTERM", () => {
  stopAll();
  process.exit(143);
});

let status = 1;
try {
  for (const service of SERVICES) {
    const log = openSync(join(LOGS, `${service.name}.log`), "w");
    const child = spawn("bun", ["run", ...service.run], {
      cwd: join(ROOT, service.cwd),
      env: { ...process.env, NODE_ENV: "test" },
      stdio: ["ignore", log, log],
      detached: true,
    });
    running.push({ name: service.name, process: child });
  }
  for (const [index, service] of SERVICES.entries()) {
    const child = running[index]?.process;
    if (!service.ready || !child) continue;
    if (!(await ready(service.ready, child))) {
      const log = readFileSync(join(LOGS, `${service.name}.log`), "utf8");
      console.error(log.split("\n").slice(-50).join("\n"));
      throw new Error(`${service.name} never became ready (logs/${service.name}.log)`);
    }
    ok(`${service.name} ready`);
  }
  const playwright = spawnSync("bunx", ["playwright", "test", ...process.argv.slice(2)], {
    cwd: join(ROOT, "apps/web"),
    stdio: "inherit",
  });
  status = playwright.status ?? 1;
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  stopAll();
}
process.exit(status);
