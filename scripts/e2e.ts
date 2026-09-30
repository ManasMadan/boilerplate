/**
 * Runs the end-to-end suite against a stack it builds and starts itself, then stops it.
 * CI and local runs use this same script, so both test exactly what was just built.
 *
 *   bun run test:e2e                         every suite (web, mobile, then the load smoke)
 *   bun run test:e2e --app web e2e/assistant.spec.ts   one app; the rest goes to Playwright
 *   bun run test:e2e --app load              the k6 smoke run (load/api.ts) on its own
 *   bun run test:e2e --shard=2/4             a quarter of the browser tests, as each CI runner does
 *
 * The mobile suite runs the app's screens rendered for the web (react-native-web),
 * served with the API on their own origin (apps/mobile/scripts/serve-web.ts). The load
 * smoke runs last, against the same stack, with the worker relaying what it writes.
 *
 * It refuses to start while anything already listens on the stack's ports: an older
 * server would answer instead and the run would test stale code. To iterate against a
 * stack you are already running (`bun dev`), use `bun run --cwd apps/web test:e2e`.
 *
 * Postgres, Valkey, Mailpit, RustFS and ClamAV come from `bun run db:up:full`
 * (CI starts its own); the services run as NODE_ENV=test, since production refuses the
 * local stand-ins the suite relies on. What runs is still the production build.
 */
import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { mkdirSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fail, listening, ok, ROOT, runSync } from "./lib";

const MOBILE_WEB = "http://localhost:3100";

const SERVICES = [
  {
    name: "fake-stripe",
    cwd: "packages/fake-stripe",
    run: ["start"],
    ready: "http://127.0.0.1:12111/__fake/state",
  },
  {
    name: "api",
    cwd: "apps/api",
    run: ["start"],
    ready: "http://localhost:3001/health/dependencies",
  },
  {
    name: "worker",
    cwd: "apps/worker",
    run: ["start"],
    ready: "http://localhost:3002/health/dependencies",
  },
  {
    name: "notifications",
    cwd: "apps/notifications",
    run: ["start"],
    ready: "http://localhost:3003/health/dependencies",
  },
  {
    name: "webhooks",
    cwd: "apps/webhooks",
    run: ["start"],
    ready: "http://localhost:3004/health/dependencies",
  },
  {
    name: "ai",
    cwd: "apps/ai",
    run: ["start"],
    ready: "http://localhost:8000/health/dependencies",
  },
  { name: "ai-worker", cwd: "apps/ai", run: ["worker"], ready: undefined },
  { name: "web", cwd: "apps/web", run: ["start"], ready: "http://localhost:3000/healthz" },
  { name: "mobile-web", cwd: "apps/mobile", run: ["serve:web"], ready: `${MOBILE_WEB}/healthz` },
] as const;

const BUILT = ["@repo/api", "@repo/worker", "@repo/notifications", "@repo/webhooks", "@repo/web"];
const READY_TIMEOUT_MS = 90_000;

/** Whether something accepts connections at the URL's host and port. */
export const listeningAt = (url: string) => {
  const { hostname, port } = new URL(url);
  return listening(Number(port), 1000, hostname);
};

/** What the run starts and waits with; the tests replace them. */
export interface Stack {
  run: typeof runSync;
  start: (
    command: string,
    args: string[],
    options: SpawnOptions,
  ) => Pick<ChildProcess, "pid" | "exitCode">;
  kill: (pid: number, signal: NodeJS.Signals) => unknown;
  isListening: (url: string) => Promise<boolean>;
  fetch: (url: string) => Promise<{ ok: boolean }>;
  sleep: (ms: number) => Promise<unknown>;
  onSignal: (signal: NodeJS.Signals, handler: () => void) => unknown;
  exit: (code: number) => unknown;
  logs: string;
  readyTimeoutMs: number;
}

const REAL: Stack = {
  run: runSync,
  start: spawn,
  kill: process.kill.bind(process),
  isListening: listeningAt,
  fetch,
  sleep,
  onSignal: process.on.bind(process),
  exit: process.exit.bind(process),
  logs: join(ROOT, "logs"),
  readyTimeoutMs: READY_TIMEOUT_MS,
};

type Running = { name: string; process: Pick<ChildProcess, "pid" | "exitCode"> };

/** Whether `url` answers before the stack's timeout, as long as `child` keeps running. */
async function ready(stack: Stack, url: string, child: Pick<ChildProcess, "exitCode">) {
  const deadline = Date.now() + stack.readyTimeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return false;
    const response = await stack.fetch(url).catch(() => undefined);
    if (response?.ok) return true;
    await stack.sleep(500);
  }
  return false;
}

/** The services whose port something else already listens on. */
async function busyServices(stack: Stack) {
  const listeningNow = await Promise.all(
    SERVICES.map(async (s) => (s.ready && (await stack.isListening(s.ready)) ? s : undefined)),
  );
  return listeningNow.filter((s) => s !== undefined);
}

/**
 * The suites `argv` asks for (`--app web|mobile|load`, all of them by default) and the
 * arguments for Playwright; undefined when `--app` names something else.
 */
function suitesFor(argv: string[]) {
  const appFlag = argv.indexOf("--app");
  const playwrightArgs =
    appFlag === -1 ? argv : argv.filter((_, i) => i !== appFlag && i !== appFlag + 1);
  // Sharded (`--shard=2/4`, CI runs four), the browser suites split and the load test,
  // which isn't Playwright, runs on the first shard only.
  const shard = playwrightArgs.find((arg) => arg.startsWith("--shard="));
  const everything =
    !shard || shard.startsWith("--shard=1/") ? ["web", "mobile", "load"] : ["web", "mobile"];
  const apps = appFlag === -1 ? everything : [argv[appFlag + 1]];
  if (!apps.every((app) => app === "web" || app === "mobile" || app === "load")) return undefined;
  return { apps, playwrightArgs };
}

/** The production builds the stack runs; the exit code of the first that fails, or 0. */
function build(stack: Stack) {
  for (const [command = "", ...rest] of [
    ["bunx", "turbo", "run", "build", ...BUILT.map((p) => `--filter=${p}`)],
    ["bun", "run", "--cwd", "apps/mobile", "build:web"],
  ]) {
    const built = stack.run(command, rest, {
      cwd: ROOT,
      stdio: "inherit",
      env: { ...process.env, NODE_ENV: "production" },
    });
    if (built.status !== 0) return built.status ?? 1;
  }
  return 0;
}

/** Stops every service still running. */
function stopAll(stack: Stack, running: Running[]) {
  for (const { process: child } of running) {
    // Each service runs in its own process group (bun → uv → python, for example).
    if (child.pid && child.exitCode === null) {
      try {
        stack.kill(-child.pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    }
  }
}

/** Starts every service, each logging to its own file, then waits until each is ready. */
async function startAll(stack: Stack, running: Running[]) {
  for (const service of SERVICES) {
    const log = openSync(join(stack.logs, `${service.name}.log`), "w");
    const child = stack.start("bun", ["run", ...service.run], {
      cwd: join(ROOT, service.cwd),
      // The mobile web build signs users in from its own origin.
      env: { ...process.env, NODE_ENV: "test", APP_ORIGINS: MOBILE_WEB },
      stdio: ["ignore", log, log],
      detached: true,
    });
    running.push({ name: service.name, process: child });
  }
  for (const [index, service] of SERVICES.entries()) {
    const child = running[index]?.process;
    if (!service.ready || !child) continue;
    if (!(await ready(stack, service.ready, child))) {
      const log = readFileSync(join(stack.logs, `${service.name}.log`), "utf8");
      console.error(log.split("\n").slice(-50).join("\n"));
      throw new Error(`${service.name} never became ready (logs/${service.name}.log)`);
    }
    ok(`${service.name} ready`);
  }
}

/** Runs each suite against the running stack; 0 when all pass, else a failing one's code. */
function runSuites(stack: Stack, apps: string[], playwrightArgs: string[]) {
  let status = 0;
  for (const app of apps) {
    const suite =
      app === "load"
        ? stack.run("bun", ["run", "test:load"], {
            cwd: join(ROOT, "load"),
            stdio: "inherit",
            env: { ...process.env, NODE_ENV: "test" },
          })
        : stack.run("bunx", ["playwright", "test", ...playwrightArgs], {
            cwd: join(ROOT, `apps/${app}`),
            stdio: "inherit",
          });
    if (suite.status !== 0) status = suite.status ?? 1;
  }
  return status;
}

/** Builds, starts the stack, runs the suites `argv` picks and stops it; the exit code. */
export async function e2e(
  argv = process.argv.slice(2),
  given: Partial<Stack> = {},
): Promise<number> {
  const stack = { ...REAL, ...given };

  const busy = await busyServices(stack);
  if (busy.length > 0) {
    for (const s of busy) fail(`${s.name}: something already listens on ${new URL(s.ready).host}`);
    console.error(
      "Stop the running stack first, or test against it with `bun run --cwd apps/web test:e2e`.",
    );
    return 1;
  }

  const suites = suitesFor(argv);
  if (!suites) {
    fail("--app is web, mobile or load");
    return 1;
  }

  const built = build(stack);
  if (built !== 0) return built;

  mkdirSync(stack.logs, { recursive: true });
  const running: Running[] = [];
  stack.onSignal("SIGINT", () => {
    stopAll(stack, running);
    stack.exit(130);
  });
  stack.onSignal("SIGTERM", () => {
    stopAll(stack, running);
    stack.exit(143);
  });

  try {
    await startAll(stack, running);
    return runSuites(stack, suites.apps, suites.playwrightArgs);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    stopAll(stack, running);
  }
}

if (import.meta.main) process.exit(await e2e());
