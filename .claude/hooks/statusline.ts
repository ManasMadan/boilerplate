/**
 * Status line: branch, uncommitted changes and which core local services accept
 * connections. It runs after every assistant message, so it stays at about 100ms: one
 * git call and a TCP connect per service (localhost refuses instantly when nothing
 * listens). It never calls Docker, which can take seconds to answer.
 */
import { listening } from "../../scripts/lib";

// The default host ports from docker-compose.yml. Overrides in .env are not read here.
const SERVICES = [
  { name: "pg", port: 55432 },
  { name: "valkey", port: 56379 },
  { name: "mail", port: 51025 },
];

/** The status line for the session `stdin` describes (JSON; anything else is ignored). */
export async function statusline(
  stdin: { json(): Promise<unknown> } = Bun.stdin,
  services = SERVICES,
): Promise<string> {
  const input = (await stdin.json().catch(() => ({}))) as {
    workspace?: { project_dir?: string };
  };
  const cwd = input.workspace?.project_dir ?? process.cwd();

  const git = Bun.spawnSync(["git", "status", "--porcelain=v1", "--branch"], { cwd });
  const [head = "", ...changes] = git.stdout.toString().trim().split("\n");
  const branch = head.replace(/^## /, "").split("...")[0] || "no git";
  const dirty = changes.filter(Boolean).length;

  const up = await Promise.all(services.map((service) => listening(service.port, 150)));
  const status = services
    .map((service, index) => `${service.name} ${up[index] ? "up" : "down"}`)
    .join(" ");
  return `${branch}${dirty ? ` +${dirty}` : ""} | ${status}`;
}

if (import.meta.main) process.stdout.write(await statusline());
